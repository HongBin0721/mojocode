/**
 * `/review` 命令的服务端核心:解析审查范围、收集 git 摘要、组稿审查提示词。
 * 收集器与范围块也被 `/simplify` 复用(见 simplify.ts)。
 *
 * 与 init.ts 同级的"罐装指令"模块。设计要点(见 tests/review.test.ts):
 *  - **不把完整 diff 嵌进提示词**——大 diff 会撑爆持久历史,而 bash 工具输出
 *   本身有 20K 截断;这里只嵌小型摘要(porcelain / diffstat / oneline log,
 *   各自封顶),由模型用 read 工具和下面列出的命令自己取全量。
 *  - **嵌入提示词的命令只准用安全前缀**(bash-rules.ts 的 SAFE_PREFIXES:
 *   git status / log / diff / show)。`git merge-base` 不在其中,所以 base
 *   范围的 merge-base 在这里解析成 SHA 再嵌——模型全程零确认弹窗。
 *  - 失败以 reason 代码返回、不抛异常:UI 据此映射本地化提示,免得英文
 *   错误串直接怼进时间线。
 */

import { execa } from 'execa';

/** 摘要各段的行数上限;超出部分以 `... N more` 呈现,模型仍可自己跑全量。 */
export const MAX_LOG_LINES = 100;
export const MAX_STAT_LINES = 150;
export const MAX_STATUS_LINES = 200;
/** 分支选择器里分支条目的上限(按最近提交排序取前 N)。 */
export const MAX_BRANCHES = 50;
/** 提交选择器列出的最近提交数。 */
export const MAX_REVIEW_COMMITS = 30;

export type ReviewScope =
  | { kind: 'uncommitted' }
  | { kind: 'base'; branch: string }
  | { kind: 'commit'; sha: string }
  | { kind: 'custom'; instructions: string };

/** 分支选择器的一行:分支名 + 该分支最新提交的标题。 */
export interface ReviewBranch {
  name: string;
  subject: string;
}

/** 提交选择器的一行(sha 为 git 自己给出的短 SHA)。 */
export interface ReviewCommit {
  sha: string;
  subject: string;
  /** 相对时间(git --date=relative 的输出,如 "2 hours ago")。 */
  date: string;
}

/** 选择器数据源(server 侧跑 git;--attach 时仓库在 server 机器上)。 */
export interface ReviewTargets {
  isRepo: boolean;
  /** detached HEAD 时为真(uncommitted / commit 仍可用)。 */
  detached: boolean;
  currentBranch?: string;
  /** 除当前分支外的本地分支,按最近提交时间倒序。 */
  branches: ReviewBranch[];
}

export type ReviewFailure =
  | 'no-repo'
  | 'clean-tree'
  | 'no-commits'
  | 'no-diff'
  | 'unknown-branch'
  | 'same-branch'
  | 'no-merge-base'
  | 'unknown-commit'
  | 'git-error'
  /** 参数不认识(UI 侧已拦 usage;server 侧权威再解析一次的防御性兜底)。 */
  | 'bad-arg';

export interface ReviewFailureInfo {
  ok: false;
  reason: ReviewFailure;
  /** base 范围失败时的分支名(no-diff / unknown-branch / ...)。 */
  branch?: string;
  /** commit 范围失败时的 sha(unknown-commit)。 */
  sha?: string;
  /** git-error 时的 stderr 首行(截断),经 notice.reviewGitError 的 {message} 呈现。 */
  detail?: string;
}

export type ReviewCollectResult = { ok: true; summary: ReviewSummary } | ReviewFailureInfo;
export type ReviewStartResult = { ok: true } | ReviewFailureInfo;

export interface ReviewSummary {
  /** HEAD 全 SHA(空仓没有;嵌命令用全 SHA 防大仓库短 SHA 歧义)。 */
  headSha?: string;
  /** commit:`git show --stat --oneline` 的首行(短 SHA + 标题)。 */
  commitOneline?: string;
  /** commit:rev-parse 解析出的全 SHA(嵌命令防短 SHA 歧义)。 */
  commitSha?: string;
  /** base:merge-base 全 SHA。 */
  mergeBaseSha?: string;
  /** base:分叉以来的提交数(rev-list --count,不受 log 封顶影响)。 */
  commitCount?: number;
  currentBranch?: string;
  /** base:`<merge-base>..HEAD` 的 oneline 日志,新在前。 */
  logLines: string[];
  /** diffstat 行。uncommitted/custom: vs HEAD;commit: git show --stat;base: vs merge-base。 */
  statLines: string[];
  /** uncommitted/custom:porcelain 状态行。 */
  statusLines: string[];
  /** 各段被裁掉的行数。 */
  truncated: { status?: number; stat?: number; log?: number };
}

/**
 * 分支名 token 的形状校验,对齐 git check-ref-format 的关键规则(见函数体)。
 * 特意比 `[A-Za-z0-9._/-]` 宽:git 允许 `feature@x`、中文分支这类名字,
 * 收集器列得出来,收窄的 token 会让"从选择器里挑了个真分支"反被解析拒掉。
 * 真伪仍由 collectReviewSummary 的 rev-parse --verify 把关——这里只提前
 * 拦住注入形状(选项前缀、区间语法)。
 */
function branchTokenOk(token: string): boolean {
  if (token.startsWith('-')) return false; // 选项注入
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(token)) return false; // git 禁字符
  if (token.includes('..') || token.includes('@{')) return false; // 区间/reflog 语法
  if (token.endsWith('.') || token.endsWith('/')) return false;
  if (token.endsWith('.lock')) return false;
  if (token.startsWith('/') || token.includes('//')) return false;
  if (token.split('/').some((part) => part.startsWith('.'))) return false; // 分段禁 . 开头
  return true;
}
/** 提交 token:7-40 位十六进制,覆盖短 SHA 到全 SHA。 */
const SHA_TOKEN = /^[0-9a-f]{7,40}$/i;

/**
 * "后接参数"的范围关键字(`uncommitted` 不算——裸打即是合法范围)。
 * parseReviewArg 只认 `keyword <参数>` 形态,裸关键字不成范围;App 侧要用
 * 它区分"半截用法"与"目标文本"(/simplify 的兜底会把任意非空文本当清理
 * 目标)。新增带参关键字时这里一处补齐,消费方共享,不再各自手抄一份。
 */
export const ARG_SCOPE_KEYWORDS: readonly string[] = ['base', 'commit', 'custom'];

/**
 * 解析 `/review <arg>` 的参数。App 侧先解析一次给 usage 提示,server 侧
 * (bootstrap.startReview)权威再解析一次——不认识的一律 undefined,由调用方
 * 决定展示什么。分支名只做形状校验,真伪交给 rev-parse --verify。裸的
 * `base`/`commit`/`custom` 在这里不成范围:App 拦下它们去开选择器/预填。
 */
export function parseReviewArg(arg: string): ReviewScope | undefined {
  const trimmed = arg.trim();
  if (trimmed === 'uncommitted') return { kind: 'uncommitted' };
  // `base` 后必须跟分支 token;恰好叫 base 的分支走 `/review base base`。
  if (trimmed.startsWith('base ')) {
    const token = trimmed.slice('base '.length).trim();
    if (branchTokenOk(token)) return { kind: 'base', branch: token };
  }
  if (trimmed.startsWith('commit ')) {
    const token = trimmed.slice('commit '.length).trim();
    if (SHA_TOKEN.test(token)) return { kind: 'commit', sha: token.toLowerCase() };
  }
  // custom 的焦点文本是自由文本,只要求非空。
  if (trimmed.startsWith('custom ')) {
    const text = trimmed.slice('custom '.length).trim();
    if (text) return { kind: 'custom', instructions: text };
  }
  return undefined;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** host 侧跑 git:不抛异常,失败带回 exitCode/stderr(照 prompt.ts / file-index.ts 的样式)。 */
async function git(root: string, args: string[]): Promise<GitResult> {
  try {
    const result = await execa('git', args, {
      cwd: root,
      reject: false,
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    // 超时 / 没装 git 等 spawn 层失败,统一归到 git-error。
    return { ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
}

function cap(stdout: string, max: number): { lines: string[]; dropped: number } {
  const lines = stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return { lines: lines.slice(0, max), dropped: Math.max(0, lines.length - max) };
}

function fail(
  reason: ReviewFailure,
  extra?: { branch?: string; sha?: string; detail?: string },
): ReviewFailureInfo {
  return { ok: false, reason, ...extra };
}

/** stderr 只取首个非空行(封 200 字符):多行错误全文进了时间线提示就没法看了。 */
function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0);
  return (line ?? '').trim().slice(0, 200);
}

/**
 * 仓库探测。注意与 gatherEnvironment 的差异:那边用 `rev-parse --abbrev-ref
 * HEAD` 判 isGitRepo(空仓会误报 false,但对系统提示无伤大雅),这里必须用
 * `--is-inside-work-tree`——空仓的 uncommitted 审查(untracked 文件)是
 * 合法场景。`branch --show-current` 在空仓也能给出分支名,detached 输出空。
 */
export async function collectReviewTargets(root: string): Promise<ReviewTargets> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { isRepo: false, detached: false, branches: [] };
  }
  const branch = await git(root, ['branch', '--show-current']);
  const currentBranch = branch.ok ? branch.stdout.trim() : '';
  const list = await git(root, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)%09%(subject)',
    'refs/heads',
  ]);
  const branches: ReviewBranch[] = (list.ok ? list.stdout.split('\n') : [])
    .map((line) => {
      // 分支名不含 tab,首个 tab 前是名字;subject 自身含 tab 时原样保留。
      const sep = line.indexOf('\t');
      return {
        name: (sep === -1 ? line : line.slice(0, sep)).trim(),
        subject: (sep === -1 ? '' : line.slice(sep + 1)).trim(),
      };
    })
    .filter((entry) => entry.name && entry.name !== currentBranch)
    .slice(0, MAX_BRANCHES);
  return { isRepo: true, detached: !currentBranch, currentBranch: currentBranch || undefined, branches };
}

/** 提交选择器的数据源:最近 N 个提交(新在前)。非仓库/空仓/失败一律空表。 */
export async function collectReviewCommits(root: string): Promise<ReviewCommit[]> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') return [];
  const log = await git(root, ['log', '-n', String(MAX_REVIEW_COMMITS), '--format=%h%x09%s%x09%cr']);
  if (!log.ok) return [];
  return log.stdout
    .split('\n')
    .map((line) => {
      // 首个 tab 是 sha、末个 tab 是日期;subject 内含 tab 的病态提交中间重组。
      const [sha = '', ...rest] = line.split('\t');
      const date = rest.length > 1 ? (rest.pop() ?? '') : '';
      return { sha: sha.trim(), subject: rest.join('\t').trim(), date: date.trim() };
    })
    .filter((entry) => entry.sha)
    .slice(0, MAX_REVIEW_COMMITS);
}

/** 校验范围 + 收集摘要。失败走 reason 代码,绝不抛异常。 */
export async function collectReviewSummary(
  root: string,
  scope: ReviewScope,
): Promise<ReviewCollectResult> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') return fail('no-repo');
  // 分支名对三个范围都有用(uncommitted 的 scope 描述也带它),统一先取。
  const branch = await git(root, ['branch', '--show-current']);
  const currentBranch = (branch.ok ? branch.stdout.trim() : '') || undefined;

  // custom 与 uncommitted 收集同一份摘要(未提交改动);区别只在组稿时
  // 附加用户的焦点指令。干净树对两者同样报 clean-tree——没有可审的内容。
  if (scope.kind === 'uncommitted' || scope.kind === 'custom') {
    // core.quotePath=false:porcelain 里的非 ASCII 路径不转义,模型照着能读文件。
    const status = await git(root, ['-c', 'core.quotePath=false', 'status', '--porcelain']);
    if (!status.ok) return fail('git-error', { detail: firstLine(status.stderr) });
    if (!status.stdout.trim()) return fail('clean-tree');
    const summary: ReviewSummary = { currentBranch, logLines: [], statLines: [], statusLines: [], truncated: {} };
    const head = await git(root, ['rev-parse', 'HEAD']);
    summary.headSha = head.ok ? head.stdout.trim() : undefined; // 空仓:只有 untracked 也没有 HEAD
    // stat 是次要信息(空仓必失败、纯 untracked 为空),失败或为空都容忍。
    const stat = await git(root, ['-c', 'core.quotePath=false', 'diff', '--stat', 'HEAD']);
    if (stat.ok) {
      const { lines, dropped } = cap(stat.stdout, MAX_STAT_LINES);
      summary.statLines = lines;
      summary.truncated.stat = dropped;
    }
    const cappedStatus = cap(status.stdout, MAX_STATUS_LINES);
    summary.statusLines = cappedStatus.lines;
    summary.truncated.status = cappedStatus.dropped;
    return { ok: true, summary };
  }

  if (scope.kind === 'commit') {
    const summary: ReviewSummary = { currentBranch, logLines: [], statLines: [], statusLines: [], truncated: {} };
    // ^{commit} 保证 peel 到提交对象——tree/blob/tag 指向的 sha 不认;
    // 输出即全 SHA,嵌命令防大仓库短 SHA 歧义。
    const verify = await git(root, ['rev-parse', '--verify', '--quiet', `${scope.sha}^{commit}`]);
    if (!verify.ok) return fail('unknown-commit', { sha: scope.sha });
    summary.commitSha = verify.stdout.trim();
    // --stat 恰好是"oneline + diffstat、无 patch"(实测,-s 反而连 stat 一起压掉);
    // git show 对根提交也成立,不需要 <sha>^。
    const show = await git(root, [
      '-c',
      'core.quotePath=false',
      'show',
      '--stat',
      '--oneline',
      summary.commitSha,
    ]);
    if (!show.ok) return fail('git-error', { detail: firstLine(show.stderr) });
    summary.commitOneline = cap(show.stdout, 1).lines[0] ?? summary.commitSha;
    const { lines, dropped } = cap(show.stdout, MAX_STAT_LINES);
    summary.statLines = lines;
    summary.truncated.stat = dropped;
    return { ok: true, summary };
  }

  // base 范围需要 HEAD 存在(空仓没有当前分支头可对比)。
  const head = await git(root, ['rev-parse', 'HEAD']);
  if (!head.ok) return fail('no-commits');
  const summary: ReviewSummary = {
    headSha: head.stdout.trim(),
    currentBranch,
    logLines: [],
    statLines: [],
    statusLines: [],
    truncated: {},
  };

  // base 范围。
  const { branch: baseBranch } = scope;
  // refs/heads/ 前缀保证只认本地分支——sha、tag、refs/ 都 resolve 不了。
  const verify = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`]);
  if (!verify.ok) return fail('unknown-branch', { branch: baseBranch });
  if (baseBranch === currentBranch) return fail('same-branch', { branch: baseBranch });
  // merge-base 在这里解析成 SHA:模型自己跑 `git merge-base` 会弹确认(不在
  // SAFE_PREFIXES),嵌 SHA 后它只需要 `git diff/log` 这类安全前缀命令。
  const mb = await git(root, ['merge-base', `refs/heads/${baseBranch}`, 'HEAD']);
  if (!mb.ok) return fail('no-merge-base', { branch: baseBranch });
  summary.mergeBaseSha = mb.stdout.trim();

  const log = await git(root, ['log', '--oneline', `${summary.mergeBaseSha}..HEAD`]);
  if (!log.ok) return fail('git-error', { detail: firstLine(log.stderr) });
  if (!log.stdout.trim()) return fail('no-diff', { branch: baseBranch });
  const cappedLog = cap(log.stdout, MAX_LOG_LINES);
  summary.logLines = cappedLog.lines;
  summary.truncated.log = cappedLog.dropped;

  const count = await git(root, ['rev-list', '--count', `${summary.mergeBaseSha}..HEAD`]);
  if (count.ok) summary.commitCount = Number(count.stdout.trim()) || undefined;

  const stat = await git(root, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--stat',
    summary.mergeBaseSha,
    'HEAD',
  ]);
  if (stat.ok) {
    const { lines, dropped } = cap(stat.stdout, MAX_STAT_LINES);
    summary.statLines = lines;
    summary.truncated.stat = dropped;
  }
  return { ok: true, summary };
}

/** 展示用短 SHA。 */
function shortSha(sha: string): string {
  return sha.slice(0, 10);
}

function renderLines(lines: string[], dropped: number | undefined, empty: string): string {
  if (lines.length === 0) return empty;
  return dropped ? `${lines.join('\n')}\n... ${dropped} more` : lines.join('\n');
}

function branchLine(summary: ReviewSummary): string {
  return summary.currentBranch ? `branch ${summary.currentBranch}` : 'a detached HEAD';
}

/** uncommitted 与 custom 共用的范围块(未提交改动的摘要与命令)。 */
function uncommittedBlock(summary: ReviewSummary): string {
  return [
    `Uncommitted changes in the working tree (staged, unstaged and untracked), on ${branchLine(summary)}.`,
    '',
    'git status --porcelain:',
    renderLines(summary.statusLines, summary.truncated.status, '(empty)'),
    '',
    'Diffstat of tracked changes vs HEAD:',
    renderLines(summary.statLines, summary.truncated.stat, '(no tracked changes — only untracked files)'),
    '',
    'Commands (read-only, pre-approved):',
    '- git diff --stat HEAD',
    '- git diff HEAD -- <path>    (staged + unstaged changes of one tracked file)',
    '- git status --porcelain     (lists untracked files)',
    '',
    'Untracked files (status prefix `??`) never appear in a git diff — read them with the read tool instead.',
  ].join('\n');
}

/**
 * 组稿范围块(摘要 + 只读命令),`/review` 与 `/simplify` 共用。custom 范围的
 * 用户文本引导句两边措辞不同,经 customFocusHeader 覆盖(缺省为评审措辞)。
 */
export function scopeBlock(
  scope: ReviewScope,
  summary: ReviewSummary,
  options?: { customFocusHeader?: string },
): string {
  if (scope.kind === 'uncommitted') return uncommittedBlock(summary);
  if (scope.kind === 'custom') {
    return [
      uncommittedBlock(summary),
      '',
      options?.customFocusHeader ??
        'Review focus requested by the user — weigh it above the generic guidance:',
      '',
      scope.instructions,
    ].join('\n');
  }
  if (scope.kind === 'commit') {
    const sha = summary.commitSha ?? scope.sha;
    return [
      `Commit ${summary.commitOneline ?? shortSha(sha)}`,
      '',
      renderLines(summary.statLines, summary.truncated.stat, '(no diffstat)'),
      '',
      'Commands (read-only, pre-approved):',
      `- git show --stat ${sha}`,
      `- git show ${sha} -- <path>    (this commit's change to one file; works for the root commit too)`,
    ].join('\n');
  }
  const mb = summary.mergeBaseSha ?? '';
  return [
    `Changes on ${branchLine(summary)} since it diverged from ${scope.branch} — merge-base ${shortSha(mb)}, ${summary.commitCount ?? summary.logLines.length} commit(s) ahead.`,
    '',
    'Commits, newest first:',
    renderLines(summary.logLines, summary.truncated.log, '(empty)'),
    '',
    'Diffstat vs merge-base:',
    renderLines(summary.statLines, summary.truncated.stat, '(no tracked changes)'),
    '',
    'Commands (read-only, pre-approved):',
    `- git diff --stat ${mb} HEAD`,
    `- git diff ${mb} HEAD -- <path>`,
  ].join('\n');
}

/**
 * 组稿审查提示词(英文——喂给模型的文本按约定不本地化)。
 *
 * 只读条款是用户确认过的产品语义:评审轮不准改任何文件、不准跑改状态的
 * 命令、不准调 exit_plan(评审的产出是发现清单,不是计划)。发现格式对齐
 * Codex review:按严重度排序、file:line 定位、最小具体修复、没有问题就明说。
 */
export function buildReviewPrompt(scope: ReviewScope, summary: ReviewSummary): string {
  return `Review the changes described below and report findings.

This is a read-only review. Do NOT modify, create or delete any file, do NOT
run any state-changing command (no commit, stash, checkout, rebase, branch or
worktree operations), and do NOT call exit_plan. Read the repository and report.

## Scope

${scopeBlock(scope, summary)}

## How to review

- Fetch the full diff yourself with the commands listed in the scope block.
  They are read-only and pre-approved. Diff file by file (\`... -- <path>\`) for
  large changes so no single output gets truncated.
- Read the code around each hunk — a hunk alone rarely shows whether the change
  is correct.
- Focus on real defects: bugs, logic errors, security issues, data races,
  error-handling gaps, broken tests, API misuse, performance regressions. Skip
  style nits and subjective preferences unless they hide a real problem.

## Output format

- Start with a one-paragraph summary of what the changes do.
- Then list findings, most severe first, one per line:
  [high|medium|low] path/to/file.ts:42 — what is wrong, why, and the smallest
  concrete fix.
  Cite only file:line references that exist in the diff or in files you read.
- If nothing worth reporting was found, say so explicitly; do not invent
  minor issues.`;
}
