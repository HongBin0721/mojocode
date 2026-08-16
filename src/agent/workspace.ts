/**
 * 工作区 pending 变更的只读收集(GUI Review 面板的数据源)。
 *
 * 与 review.ts 的 git 收集器同款纪律:仓库根跑子进程、不抛异常、失败带
 * reason 返回。差异是 git() 保留 exitCode——`git diff --no-index` 用 1 表示
 * 「有差异」的正常返回,不能像 review.ts 那样折叠进 ok。
 *
 * 只读:status/branch/diff,不做任何写操作(selective staging、revert 等由
 * 用户在自己的终端里完成)。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';

export interface WorkspaceFileEntry {
  path: string;
  change: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  /** 暂存区有差异(porcelain 的 X 列非空且非 ?)。 */
  staged: boolean;
  /** renamed 时的旧路径。 */
  renameFrom?: string;
  /** numstat 的每文件 +/−;二进制(输出 `-`)与 untracked/deleted 为 undefined。 */
  additions?: number;
  deletions?: number;
}

export interface WorkspaceStatus {
  ok: boolean;
  branch?: string;
  entries: WorkspaceFileEntry[];
  /** 追踪文件(tracked)的合计增删;untracked 不计。 */
  additions: number;
  deletions: number;
  truncated: boolean;
}

export type FileDiffFailure = 'no-repo' | 'not-found' | 'binary' | 'invalid-path' | 'git-error';

export interface FileDiff {
  ok: boolean;
  reason?: FileDiffFailure;
  path: string;
  /** unified diff 正文(含 @@ hunk 头;untracked 为全新增补丁)。 */
  diff?: string;
  truncated: boolean;
}

interface GitResult {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
}

/** host 侧跑 git:不抛异常,失败带回 exitCode/stderr(review.ts 同款样式 + exitCode)。 */
async function git(root: string, args: string[]): Promise<GitResult> {
  try {
    const result = await execa(
      'git',
      ['-c', 'core.quotePath=false', ...args],
      {
        cwd: root,
        reject: false,
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    // 超时 / 没装 git 等 spawn 层失败,统一归到 git-error。
    return { exitCode: undefined, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
}

const MAX_ENTRIES = 500;
/** 单文件 diff 的输出预算:Review 面板要看整文件,128KB 远大于权限卡的 8000。 */
const MAX_DIFF_CHARS = 128 * 1024;
/** untracked 文件超过此大小时不再生成补丁(读全文造补丁没有意义)。 */
const MAX_UNTRACKED_BYTES = 400 * 1024;

function failDiff(p: string, reason: FileDiffFailure): FileDiff {
  return { ok: false, reason, path: p, truncated: false };
}

/**
 * 解析 `git status --porcelain` 的一行:XY 两列状态 + 路径(R 后带 `old -> new`)。
 * `-c core.quotePath=false` 已让非 ASCII 路径原样输出,但仍防御带引号的转义形态
 * (git 对含特殊字符的路径始终加引号)——不认识的行跳过而不是崩。
 */
function parsePorcelainLine(line: string): WorkspaceFileEntry | undefined {
  if (line.length < 4) return undefined;
  const x = line[0]!;
  const y = line[1]!;
  let rest = line.slice(3);

  if (rest.startsWith('"') && rest.endsWith('"')) {
    // 去掉引号与 C 风格转义里最常见的 `\t`/`\"`;完整 unescape 交给 git 的
    // `-z` 输出才可靠,这里只是展示级兜底。
    try {
      rest = JSON.parse(rest) as string;
    } catch {
      return undefined;
    }
  }

  if (x === '?' && y === '?') {
    return { path: rest, change: 'untracked', staged: false };
  }

  let renameFrom: string | undefined;
  if ((x === 'R' || y === 'R') && rest.includes(' -> ')) {
    const separator = rest.indexOf(' -> ');
    renameFrom = rest.slice(0, separator);
    rest = rest.slice(separator + ' -> '.length);
  }

  let change: WorkspaceFileEntry['change'] = 'modified';
  if (x === 'A' || y === 'A') change = 'added';
  else if (x === 'D' || y === 'D') change = 'deleted';
  else if (renameFrom !== undefined) change = 'renamed';

  return { path: rest, change, staged: x !== ' ' && x !== '?', renameFrom };
}

/** 收集 pending 变更:status porcelain + numstat + 当前分支。非仓库返回 ok:false。 */
export async function collectWorkspaceStatus(root: string): Promise<WorkspaceStatus> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    return { ok: false, entries: [], additions: 0, deletions: 0, truncated: false };
  }

  // --untracked-files=all:porcelain 默认把全新目录折叠成 `dir/`,Review
  // 面板要的是逐文件。
  const status = await git(root, ['status', '--porcelain', '--untracked-files=all']);
  if (status.exitCode !== 0) {
    return { ok: false, entries: [], additions: 0, deletions: 0, truncated: false };
  }

  const entries: WorkspaceFileEntry[] = [];
  for (const line of status.stdout.split('\n')) {
    if (!line.trim()) continue;
    const entry = parsePorcelainLine(line);
    if (entry) entries.push(entry);
  }

  // 每文件的 +/−(vs HEAD,含已暂存)。二进制输出 `-`,保持 undefined。
  const numstat = await git(root, ['diff', 'HEAD', '--numstat']);
  if (numstat.exitCode === 0) {
    const stats = new Map<string, { additions?: number; deletions?: number }>();
    for (const line of numstat.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [added, deleted, file] = line.split('\t');
      if (!file) continue;
      stats.set(file, {
        additions: added === '-' ? undefined : Number(added),
        deletions: deleted === '-' ? undefined : Number(deleted),
      });
    }
    for (const entry of entries) {
      if (entry.change === 'untracked') continue;
      const stat = stats.get(entry.renameFrom ?? entry.path);
      if (stat) {
        entry.additions = stat.additions;
        entry.deletions = stat.deletions;
      }
    }
  }

  const branch = await git(root, ['branch', '--show-current']);

  const truncated = entries.length > MAX_ENTRIES;
  const kept = truncated ? entries.slice(0, MAX_ENTRIES) : entries;
  const additions = kept.reduce((sum, entry) => sum + (entry.additions ?? 0), 0);
  const deletions = kept.reduce((sum, entry) => sum + (entry.deletions ?? 0), 0);

  return {
    ok: true,
    branch: branch.exitCode === 0 && branch.stdout.trim() ? branch.stdout.trim() : undefined,
    entries: kept.sort((a, b) => a.path.localeCompare(b.path)),
    additions,
    deletions,
    truncated,
  };
}

/** 路径白名单:相对、无 `..` 段、不以 `-` 开头、无控制字符——git 参数注入的防线。 */
function isValidRelativePath(p: string): boolean {
  if (!p || p.startsWith('/') || p.startsWith('\\') || p.startsWith('-')) return false;
  if (p.includes('\0') || p.includes('\n') || p.includes('\r') || p.includes('\t')) return false;
  // Windows 盘符形态也拒(CI 里 root 可能是 win 风格路径)。
  if (/^[a-zA-Z]:/.test(p)) return false;
  const parts = p.split(/[\\/]/);
  return parts.every((part) => part !== '..' && part !== '');
}

export async function collectFileDiff(root: string, file: string): Promise<FileDiff> {
  if (!isValidRelativePath(file)) return failDiff(file, 'invalid-path');

  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return failDiff(file, 'no-repo');

  const status = await git(root, ['status', '--porcelain', '--', file]);
  if (status.exitCode === 0 && status.stdout.trim() === '') return failDiff(file, 'not-found');
  const entry = status.stdout
    .split('\n')
    .map((line) => parsePorcelainLine(line))
    .find((parsed) => parsed !== undefined);
  const isUntracked = entry?.change === 'untracked';

  if (!isUntracked) {
    // vs HEAD(暂存 + 未暂存合并),与 review.ts 嵌给模型的命令同语义。
    const diff = await git(root, ['diff', 'HEAD', '--', file]);
    if (diff.exitCode !== 0) return failDiff(file, 'git-error');
    // 已暂存但与 HEAD 无差异(如 rename 无内容变化)等情形:无补丁正文。
    const body = diff.stdout;
    return {
      ok: true,
      path: file,
      diff: body.length > MAX_DIFF_CHARS ? body.slice(0, MAX_DIFF_CHARS) : body,
      truncated: body.length > MAX_DIFF_CHARS,
    };
  }

  // untracked:全新增补丁。二进制或超大文件直接降级。
  const absolute = path.resolve(root, file);
  let content: Buffer;
  try {
    const stat = await readFile(absolute);
    content = stat;
  } catch {
    return failDiff(file, 'not-found');
  }
  if (content.subarray(0, 8000).includes(0)) return failDiff(file, 'binary');
  if (content.byteLength > MAX_UNTRACKED_BYTES) return failDiff(file, 'binary');

  // exitCode 1 = 有差异的正常返回;0 表示无差异(不该发生,防御处理)。
  const diff = await git(root, ['diff', '--no-index', '--', '/dev/null', file]);
  if (diff.exitCode !== 0 && diff.exitCode !== 1) return failDiff(file, 'git-error');
  const body = diff.stdout;
  return {
    ok: true,
    path: file,
    diff: body.length > MAX_DIFF_CHARS ? body.slice(0, MAX_DIFF_CHARS) : body,
    truncated: body.length > MAX_DIFF_CHARS,
  };
}
