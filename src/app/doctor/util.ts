import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** 联网检查的最长等待。诊断命令必须能在十几秒内给出结论,不能吊着不动。 */
export const NETWORK_TIMEOUT_MS = 8_000;

/** 只比较 `x.y.z` 三段数字;预发布后缀(-beta.1)按小于同号正式版处理。 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: boolean } => {
    const [core = '', ...rest] = v.trim().replace(/^v/, '').split('-');
    return {
      nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
      pre: rest.length > 0,
    };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  return left.pre ? -1 : 1;
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
