/**
 * workspace-write(GUI 显式 git 写操作)的夹具测试:真实 git 仓库,覆盖
 * 脏树拒切、提交/撤销/丢弃的状态闭环与 reason 码。
 */

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { commitAll, discardAll, switchBranch, undoCommit } from '../src/agent/workspace-write.js';
import { collectWorkspaceStatus } from '../src/agent/workspace.js';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function makeRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'mojocode-ws-write-'));
  roots.push(root);
  await execa('git', ['init', '-b', 'main'], { cwd: root });
  await execa('git', ['config', 'user.email', 'test@test'], { cwd: root });
  await execa('git', ['config', 'user.name', 'test'], { cwd: root });
  writeFileSync(join(root, 'a.txt'), 'base\n');
  await execa('git', ['add', '.'], { cwd: root });
  await execa('git', ['commit', '-m', 'init'], { cwd: root });
  return root;
}

describe('switchBranch', () => {
  it('干净树切换成功;脏树拒绝(dirty);非法名与未知分支各有 reason', async () => {
    const root = await makeRepo();
    await execa('git', ['branch', 'feature'], { cwd: root });

    const ok = await switchBranch(root, 'feature');
    expect(ok).toMatchObject({ ok: true, branch: 'feature' });

    writeFileSync(join(root, 'a.txt'), 'dirty\n');
    expect((await switchBranch(root, 'main')).reason).toBe('dirty');

    await execa('git', ['checkout', '--', '.'], { cwd: root });
    expect((await switchBranch(root, '-bad')).reason).toBe('invalid-name');
    expect((await switchBranch(root, 'no-such-branch')).reason).toBe('unknown-branch');
  }, 20_000);

  it('非 git 目录 → no-repo', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'mojocode-ws-plain-'));
    roots.push(plain);
    expect((await switchBranch(plain, 'main')).reason).toBe('no-repo');
  }, 20_000);
});

describe('commitAll / undoCommit', () => {
  it('提交全部 pending → 干净树 + 返回 sha;撤销后回到 pending', async () => {
    const root = await makeRepo();
    writeFileSync(join(root, 'a.txt'), 'changed\n');
    writeFileSync(join(root, 'new.txt'), 'brand new\n');

    const committed = await commitAll(root, 'gui: approve\n\nmulti-line message');
    expect(committed.ok).toBe(true);
    expect(committed.sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await collectWorkspaceStatus(root)).entries).toEqual([]);

    // 干净树再提交 → clean-tree。
    expect((await commitAll(root, 'again')).reason).toBe('clean-tree');

    // 撤销:改动回到 pending(staged),文件内容原样。
    const undone = await undoCommit(root);
    expect(undone.ok).toBe(true);
    const status = await collectWorkspaceStatus(root);
    expect(status.entries.map((e) => e.path).sort()).toEqual(['a.txt', 'new.txt']);
  }, 20_000);

  it('只有初始提交时撤销 → no-commit', async () => {
    const root = await makeRepo();
    expect((await undoCommit(root)).reason).toBe('no-commit');
  }, 20_000);
});

describe('discardAll', () => {
  it('tracked 还原、untracked 删除、ignored 不动', async () => {
    const root = await makeRepo();
    writeFileSync(join(root, '.gitignore'), 'kept.log\n');
    await execa('git', ['add', '.'], { cwd: root });
    await execa('git', ['commit', '-m', 'ignore'], { cwd: root });

    writeFileSync(join(root, 'a.txt'), 'dirty\n');
    writeFileSync(join(root, 'untracked.txt'), 'gone\n');
    writeFileSync(join(root, 'kept.log'), 'ignored survives\n');
    await execa('git', ['add', 'a.txt'], { cwd: root }); // 部分暂存也要还原

    const result = await discardAll(root);
    expect(result.ok).toBe(true);
    expect((await collectWorkspaceStatus(root)).entries).toEqual([]);
    expect(existsSync(join(root, 'untracked.txt'))).toBe(false);
    expect(existsSync(join(root, 'kept.log'))).toBe(true);
  }, 20_000);
});
