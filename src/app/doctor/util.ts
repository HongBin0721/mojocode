import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** 联网检查的最长等待。诊断命令必须能在十几秒内给出结论,不能吊着不动。 */
export const NETWORK_TIMEOUT_MS = 8_000;

/**
 * 语义化版本比较:`x.y.z` 三段数字 + 可选预发布后缀(-beta.1)。预发布按
 * semver 规则逐标识符比——纯数字段按数值、恒小于字母段,字母段按字典序;
 * 前缀全部相同时标识符更多的一方更大;预发布恒小于同号正式版。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string[] } => {
    const [core = '', ...rest] = v.trim().replace(/^v/, '').split('-');
    return {
      nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
      // 后缀里可能还有 `-`(1.0.0-beta-1),并回去一起按 `.` 拆。
      pre: rest.join('-').split('.').filter(Boolean),
    };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  const diff = comparePrerelease(left.pre, right.pre);
  return diff > 0 ? 1 : diff < 0 ? -1 : 0;
}

function comparePrerelease(a: string[], b: string[]): number {
  // 空后缀 = 正式版,恒大于任何预发布。
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i] ?? '';
    const y = b[i] ?? '';
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    // 两边都是纯数字按数值比(beta.2 < beta.10);一边数字一边字母,数字恒小;
    // 否则字典序(alpha < beta)。
    if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1;
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  // 前缀全部相同:标识符更多的一方更大(beta < beta.1)。
  return a.length - b.length;
}

/** 密钥打码:留头尾各 4 位定位是哪一把,中间抹掉。 */
export function mask(key: string): string {
  if (key.length <= 12) return '*'.repeat(Math.max(key.length, 4));
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 PATH 上找可执行命令,返回解析出的完整路径。带路径分隔符的命令按原路径
 * 检查。Windows 上按 PATHEXT 逐扩展名尝试(裸名优先,shell 习惯如此)。
 */
export async function findCommand(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const suffixes =
    process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : [''];
  const candidates = command.includes('/') || command.includes(path.sep)
    ? [command]
    : (env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    for (const suffix of suffixes) {
      if (await isExecutableFile(candidate + suffix)) return candidate + suffix;
    }
  }
  return undefined;
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    await fs.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 沿路径向上找到第一个真实存在的祖先。用于判断"还没建的目录能不能建出来"。 */
export async function firstExisting(target: string): Promise<string> {
  let dir = target;
  for (;;) {
    if (await fileExists(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

export async function isWritable(target: string): Promise<boolean> {
  try {
    await fs.access(target, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}
