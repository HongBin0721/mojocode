/**
 * workspace 收集器(Review 面板的 server 侧数据源)的夹具测试:真实 git
 * 仓库(mkdtemp + git init),覆盖 porcelain 解析、numstat 合计、untracked
 * 全新增补丁、路径校验与降级 reason。
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { collectFileDiff, collectWorkspaceStatus } from '../src/agent/workspace.js';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function makeRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'mojocode-workspace-'));
  roots.push(root);
  await execa('git', ['init'], { cwd: root });
  await execa('git', ['config', 'user.email', 'test@test'], { cwd: root });
  await execa('git', ['config', 'user.name', 'test'], { cwd: root });
  writeFileSync(join(root, 'a.txt'), 'line1\nline2\nline3\n');
  writeFileSync(join(root, 'del.txt'), 'x\n');
  await execa('git', ['add', '.'], { cwd: root });
  await execa('git', ['commit', '-m', 'init'], { cwd: root });
  return root;
}

describe('collectWorkspaceStatus', () => {
  it('干净树:ok 且空表', async () => {
    const root = await makeRepo();
    const status = await collectWorkspaceStatus(root);
    expect(status.ok).toBe(true);
    expect(status.entries).toEqual([]);
    expect(status.additions).toBe(0);
    expect(status.deletions).toBe(0);
  });

  it('改/删/增/untracked/rename 条目与 numstat 合计', async () => {
    const root = await makeRepo();
    writeFileSync(join(root, 'a.txt'), 'line1\nCHANGED\nline3\nline4\n'); // +2 −1
    unlinkSync(join(root, 'del.txt')); // −1
    writeFileSync(join(root, 'new.txt'), 'a\nb\n'); // untracked,不计 numstat
    const status = await collectWorkspaceStatus(root);
    expect(status.ok).toBe(true);
    const byPath = Object.fromEntries(status.entries.map((e) => [e.path, e]));
    expect(byPath['a.txt']).toMatchObject({ change: 'modified', additions: 2, deletions: 1 });
    expect(byPath['del.txt']).toMatchObject({ change: 'deleted', deletions: 1 });
    expect(byPath['new.txt']).toMatchObject({ change: 'untracked' });
    expect('additions' in byPath['new.txt']!).toBe(false);
    expect(status.additions).toBe(2);
    expect(status.deletions).toBe(2);
  });

  it('rename 条目带 renameFrom', async () => {
    const root = await makeRepo();
    renameSync(join(root, 'a.txt'), join(root, 'b.txt'));
    await execa('git', ['add', '.'], { cwd: root }); // staged rename
    const status = await collectWorkspaceStatus(root);
    const entry = status.entries.find((e) => e.change === 'renamed');
    expect(entry).toMatchObject({ path: 'b.txt', renameFrom: 'a.txt', staged: true });
  });

  it('非 git 仓库:ok:false', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mojocode-nonrepo-'));
    roots.push(root);
    expect((await collectWorkspaceStatus(root)).ok).toBe(false);
  });
});

describe('collectFileDiff', () => {
  it('tracked 文件:vs HEAD 的 unified diff', async () => {
    const root = await makeRepo();
    writeFileSync(join(root, 'a.txt'), 'line1\nCHANGED\n');
    const diff = await collectFileDiff(root, 'a.txt');
    expect(diff.ok).toBe(true);
    expect(diff.diff).toContain('@@');
    expect(diff.diff).toContain('-line2');
    expect(diff.diff).toContain('+CHANGED');
    expect(diff.truncated).toBe(false);
  });

  it('untracked 文件:全新增补丁,带 @@ 头', async () => {
    const root = await makeRepo();
    writeFileSync(join(root, 'fresh.ts'), 'export const x = 1;\n');
    const diff = await collectFileDiff(root, 'fresh.ts');
    expect(diff.ok).toBe(true);
    expect(diff.diff).toContain('@@');
    expect(diff.diff).toContain('+export const x = 1;');
  });

  it('二进制文件 → binary;干净文件 → not-found;非仓库 → no-repo', async () => {
    const root = await makeRepo();
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x89, 0x00, 0x50, 0x4e, 0x47]));
    expect(await collectFileDiff(root, 'blob.bin')).toMatchObject({ ok: false, reason: 'binary' });
    expect(await collectFileDiff(root, 'a.txt')).toMatchObject({ ok: false, reason: 'not-found' });
    const nonRepo = mkdtempSync(join(tmpdir(), 'mojocode-nonrepo2-'));
    roots.push(nonRepo);
    expect(await collectFileDiff(nonRepo, 'x.txt')).toMatchObject({ ok: false, reason: 'no-repo' });
  });

  it('路径校验:绝对路径 / .. 段 / - 开头 / 控制字符一律 invalid-path', async () => {
    const root = await makeRepo();
    for (const bad of ['/etc/passwd', '../outside.txt', '-rf', 'a\nb', '']) {
      expect(await collectFileDiff(root, bad)).toMatchObject({ ok: false, reason: 'invalid-path' });
    }
  });

  it('超大 diff 被截断并标记', async () => {
    const root = await makeRepo();
    // 生成 > 128KB 的 tracked 改动。
    writeFileSync(
      join(root, 'big.txt'),
      Array.from({ length: 20000 }, (_, i) => `big line ${i}`).join('\n') + '\n',
    );
    await execa('git', ['add', '.'], { cwd: root });
    await execa('git', ['commit', '-m', 'big'], { cwd: root });
    writeFileSync(
      join(root, 'big.txt'),
      Array.from({ length: 20000 }, (_, i) => `CHANGED ${i}`).join('\n') + '\n',
    );
    const diff = await collectFileDiff(root, 'big.txt');
    expect(diff.ok).toBe(true);
    expect(diff.truncated).toBe(true);
    expect(diff.diff!.length).toBeLessThanOrEqual(128 * 1024);
  });

  it('子目录路径可用(相对路径解析)', async () => {
    const root = await makeRepo();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'mod.ts'), 'export {}\n');
    const status = await collectWorkspaceStatus(root);
    expect(status.entries.map((e) => e.path)).toContain('src/mod.ts');
    const diff = await collectFileDiff(root, 'src/mod.ts');
    expect(diff.ok).toBe(true);
    expect(diff.diff).toContain('+export {}');
  });
});
