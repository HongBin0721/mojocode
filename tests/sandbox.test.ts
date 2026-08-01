import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { matchGlob, resolveInsideWorkspace, SandboxError } from '../src/permissions/sandbox.js';

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
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'kdg-sandbox-'));
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
