/**
 * 工作区 git **写操作**(workspace.ts 只读收集器的写侧对偶)。
 *
 * 信任模型:这些函数只被 serve 的 RPC dispatch 调用,对应用户在 GUI 上的
 * **显式操作**(点「批准并提交」、选分支、确认丢弃)——Bearer token 即信任
 * 边界,不经 PermissionGate,也不受 bash-rules 对 `git reset --hard` 的硬拒
 * 约束:那条硬拒针对的是模型,不是用户。绝不能把这里的函数暴露给模型工具。
 *
 * 失败纪律与只读侧一致:不抛异常,reason 码 + stderr 首行(截断)返回。
 */

import { git } from './workspace.js';

export type GitOpFailure =
  | 'no-repo'
  | 'dirty'
  | 'unknown-branch'
  | 'invalid-name'
  | 'clean-tree'
  | 'no-commit'
  | 'git-error';

export interface GitOpResult {
  ok: boolean;
  reason?: GitOpFailure;
  /** switchBranch 成功后的当前分支。 */
  branch?: string;
  /** commitAll 成功后的 HEAD sha。 */
  sha?: string;
  /** git-error 时 stderr 首行(截断)——ReviewFailure.detail 同款纪律,永不带整段 blob。 */
  detail?: string;
}

/** stderr 首行,截断到一行能看的长度。 */
function firstLine(stderr: string): string {
  return stderr.split('\n')[0]?.slice(0, 200) ?? '';
}

async function insideRepo(root: string): Promise<boolean> {
  const probe = await git(root, ['rev-parse', '--is-inside-work-tree']);
  return probe.exitCode === 0 && probe.stdout.trim() === 'true';
}

/**
 * 切换分支。脏工作树直接拒绝(reason: 'dirty')——切换造成的自动合并/冲突
 * 不该发生在用户没看着的地方;GUI 提示先提交或丢弃。
 */
export async function switchBranch(root: string, name: string): Promise<GitOpResult> {
  if (!(await insideRepo(root))) return { ok: false, reason: 'no-repo' };

  // 权威校验分支名(拒 `-` 开头、控制字符等;execa 数组传参本身无 shell 注入)。
  const check = await git(root, ['check-ref-format', '--branch', name]);
  if (check.exitCode !== 0) return { ok: false, reason: 'invalid-name' };

  const status = await git(root, ['status', '--porcelain']);
  if (status.exitCode !== 0) return { ok: false, reason: 'git-error', detail: firstLine(status.stderr) };
  if (status.stdout.trim() !== '') return { ok: false, reason: 'dirty' };

  // `git switch` 而非 checkout:语义不含糊,永远不会被误解成还原文件。
  const result = await git(root, ['switch', name]);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toLowerCase();
    if (stderr.includes('invalid reference') || stderr.includes('did not match any')) {
      return { ok: false, reason: 'unknown-branch' };
    }
    return { ok: false, reason: 'git-error', detail: firstLine(result.stderr) };
  }
  const branch = await git(root, ['branch', '--show-current']);
  return { ok: true, branch: branch.stdout.trim() || name };
}

/** 提交全部 pending 变更(add -A + commit),返回 HEAD sha。 */
export async function commitAll(root: string, message: string): Promise<GitOpResult> {
  if (!(await insideRepo(root))) return { ok: false, reason: 'no-repo' };

  const status = await git(root, ['status', '--porcelain']);
  if (status.exitCode !== 0) return { ok: false, reason: 'git-error', detail: firstLine(status.stderr) };
  if (status.stdout.trim() === '') return { ok: false, reason: 'clean-tree' };

  const add = await git(root, ['add', '-A']);
  if (add.exitCode !== 0) return { ok: false, reason: 'git-error', detail: firstLine(add.stderr) };

  // message 经数组参数原样传入,任意内容安全(含引号/换行)。
  const commit = await git(root, ['commit', '-m', message]);
  if (commit.exitCode !== 0) {
    return { ok: false, reason: 'git-error', detail: firstLine(commit.stderr || commit.stdout) };
  }
  const head = await git(root, ['rev-parse', 'HEAD']);
  return { ok: true, sha: head.stdout.trim() };
}

/**
 * 撤销上一个提交但保留改动(`git reset --soft HEAD~1`)——「批准并提交」的
 * 撤销键。文件回到 pending,diff 面板自然回到未批准态。
 */
export async function undoCommit(root: string): Promise<GitOpResult> {
  if (!(await insideRepo(root))) return { ok: false, reason: 'no-repo' };
  // HEAD 没有父提交(初始提交)时 reset HEAD~1 无处可去。
  const parent = await git(root, ['rev-parse', '--verify', 'HEAD~1']);
  if (parent.exitCode !== 0) return { ok: false, reason: 'no-commit' };
  const reset = await git(root, ['reset', '--soft', 'HEAD~1']);
  if (reset.exitCode !== 0) return { ok: false, reason: 'git-error', detail: firstLine(reset.stderr) };
  return { ok: true };
}

/**
 * 丢弃全部 pending 变更:restore --staged → restore → clean -fd。
 * 刻意不用 stash(「丢弃」变「藏起来」,栈会无限堆积用户以为删掉的东西);
 * clean 不带 -x,ignored 文件(node_modules、构建产物)不动。字面语义警告:
 * untracked 的新文件会被真删——GUI 必须先弹确认并列出将被丢弃的清单
 * (workspaceStatus 现成)。
 */
export async function discardAll(root: string): Promise<GitOpResult> {
  if (!(await insideRepo(root))) return { ok: false, reason: 'no-repo' };

  const unstage = await git(root, ['restore', '--staged', '.']);
  if (unstage.exitCode !== 0) {
    // 空仓库(无 HEAD)时 restore --staged 会失败;继续走 clean 清 untracked。
    const head = await git(root, ['rev-parse', '--verify', 'HEAD']);
    if (head.exitCode === 0) {
      return { ok: false, reason: 'git-error', detail: firstLine(unstage.stderr) };
    }
  } else {
    const restore = await git(root, ['restore', '.']);
    // 干净树上 restore '.' 在无匹配路径时可能报错,不视为失败。
    if (restore.exitCode !== 0 && !restore.stderr.includes('did not match')) {
      return { ok: false, reason: 'git-error', detail: firstLine(restore.stderr) };
    }
  }

  const clean = await git(root, ['clean', '-fd']);
  if (clean.exitCode !== 0) return { ok: false, reason: 'git-error', detail: firstLine(clean.stderr) };
  return { ok: true };
}
