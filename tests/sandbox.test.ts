import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  matchGlob,
  resolveInsideWorkspace,
  resolveReadable,
  SandboxError,
} from '../src/permissions/sandbox.js';

describe('matchGlob', () => {
  it('matches literal paths', () => {
    expect(matchGlob('.env', '.env')).toBe(true);
    expect(matchGlob('.env', '.envrc')).toBe(false);
  });

  it('does not let * cross a directory boundary', () => {
    expect(matchGlob('src/*.ts', 'src/index.ts')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/nested/index.ts')).toBe(false);
  });

  it('matches ** across directories, including zero of them', () => {
    expect(matchGlob('**/.env', '.env')).toBe(true);
    expect(matchGlob('**/.env', 'packages/app/.env')).toBe(true);
    expect(matchGlob('src/**', 'src/a/b/c.ts')).toBe(true);
  });

  it('escapes regex metacharacters in the pattern', () => {
    expect(matchGlob('a.b', 'axb')).toBe(false);
    expect(matchGlob('a.b', 'a.b')).toBe(true);
  });
});

describe('resolveInsideWorkspace', () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-sandbox-'));
    root = path.join(base, 'workspace');
    outside = path.join(base, 'outside');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export {};\n');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret\n');
    await fs.writeFile(path.join(root, '.env'), 'TOKEN=abc\n');
  });

  afterAll(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  it('accepts a relative path inside the workspace', async () => {
    const resolved = await resolveInsideWorkspace('src/index.ts', { root });
    expect(resolved.relative).toBe('src/index.ts');
  });

  it('accepts a path that does not exist yet', async () => {
    const resolved = await resolveInsideWorkspace('src/new/deep/file.ts', { root });
    expect(resolved.relative).toBe('src/new/deep/file.ts');
  });

  it('rejects ../ escapes', async () => {
    await expect(resolveInsideWorkspace('../outside/secret.txt', { root })).rejects.toBeInstanceOf(
      SandboxError,
    );
  });

  it('rejects absolute paths outside the workspace', async () => {
    await expect(
      resolveInsideWorkspace(path.join(outside, 'secret.txt'), { root }),
    ).rejects.toBeInstanceOf(SandboxError);
  });

  it('rejects the workspace root itself', async () => {
    await expect(resolveInsideWorkspace('.', { root })).rejects.toBeInstanceOf(SandboxError);
  });

  it('follows symlinks before checking containment', async () => {
    const link = path.join(root, 'escape');
    await fs.symlink(outside, link, 'dir');
    await expect(resolveInsideWorkspace('escape/secret.txt', { root })).rejects.toBeInstanceOf(
      SandboxError,
    );
  });

  it('blocks secrets by default', async () => {
    await expect(resolveInsideWorkspace('.env', { root })).rejects.toThrow(/deny rule/);
    await expect(resolveInsideWorkspace('.git/config', { root })).rejects.toThrow(/deny rule/);
  });

  it('honours extra deny rules from config', async () => {
    await expect(
      resolveInsideWorkspace('src/index.ts', { root, denyPath: ['src/**'] }),
    ).rejects.toThrow(/deny rule/);
  });
});

describe('resolveReadable(只读扩根)', () => {
  let root: string;
  let skillDir: string;
  let outside: string;

  beforeAll(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-extraroot-'));
    root = path.join(base, 'workspace');
    skillDir = path.join(base, 'skills', 'demo');
    outside = path.join(base, 'elsewhere');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(skillDir, 'references'), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export {};\n');
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\ndescription: d\n---\nbody\n');
    await fs.writeFile(path.join(skillDir, 'references', 'guide.md'), 'guide\n');
    await fs.writeFile(path.join(skillDir, '.env'), 'SECRET=x\n');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'nope\n');
  });

  afterAll(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  const opts = () => ({ root, extraReadRoots: [skillDir] });

  it('工作区内路径行为与 resolveInsideWorkspace 一致', async () => {
    const resolved = await resolveReadable('src/index.ts', opts());
    expect(resolved.relative).toBe('src/index.ts');
  });

  it('扩根内的文件可读,relative 是绝对 posix 路径', async () => {
    const resolved = await resolveReadable(path.join(skillDir, 'references', 'guide.md'), opts());
    // absolute 是 realpath 过的(macOS 上 /var → /private/var),与主根语义一致。
    expect(resolved.absolute).toBe(
      await fs.realpath(path.join(skillDir, 'references', 'guide.md')),
    );
    expect(resolved.relative).toContain('references/guide.md');
    expect(resolved.relative.startsWith('..')).toBe(false);
  });

  it('扩根内的 .env 照样被默认拒绝规则挡住', async () => {
    await expect(resolveReadable(path.join(skillDir, '.env'), opts())).rejects.toBeInstanceOf(
      SandboxError,
    );
  });

  it('两边都不包含的路径抛错;无扩根时行为回退工作区判定', async () => {
    await expect(resolveReadable(path.join(outside, 'secret.txt'), opts())).rejects.toBeInstanceOf(
      SandboxError,
    );
    await expect(
      resolveReadable(path.join(skillDir, 'SKILL.md'), { root }),
    ).rejects.toBeInstanceOf(SandboxError);
  });

  // 扩根不是拒绝规则的绕行道:项目级技能目录本身就在工作区内,工作区
  // 判定拒掉的文件不能因为"它也在某个扩根里"而被放行。
  it('工作区内被 denyPath 拒绝的文件,即使落在扩根里也依然被拒', async () => {
    const inRoot = path.join(root, 'skills', 'demo');
    await fs.mkdir(inRoot, { recursive: true });
    await fs.writeFile(path.join(inRoot, 'notes.md'), 'secret\n');
    await expect(
      resolveReadable(path.join(inRoot, 'notes.md'), {
        root,
        denyPath: ['skills/**'],
        extraReadRoots: [inRoot],
      }),
    ).rejects.toThrow(/deny rule/);
    // 同一个扩根在没有拒绝规则时照常可读(证明上面拒的是规则,不是扩根失效)。
    await expect(
      resolveReadable(path.join(inRoot, 'notes.md'), { root, extraReadRoots: [inRoot] }),
    ).resolves.toMatchObject({ relative: expect.stringContaining('notes.md') });
  });

  it('扩根内的符号链接逃逸到别处被拒(realpath 防御)', async () => {
    const link = path.join(skillDir, 'escape');
    await fs.symlink(outside, link, 'dir');
    await expect(resolveReadable(path.join(skillDir, 'escape', 'secret.txt'), opts())).rejects.toBeInstanceOf(
      SandboxError,
    );
  });
});
