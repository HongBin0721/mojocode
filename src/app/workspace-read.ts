import fs from 'node:fs/promises';
import { resolveInsideWorkspace, SandboxError } from '../permissions/sandbox.js';
import { looksBinary } from '../tools/files.js';

/**
 * GUI 文件预览的读取器(`readFile` RPC 的实现)。必须跑在 server 侧:
 * `--attach` 场景下仓库在 server 那台机器,GUI 直接读盘读不到。
 *
 * 失败一律以 reason 码返回、不抛异常(FileDiff 的先例)——GUI 好渲染灰态;
 * 路径防线完整复用 sandbox.ts(realpath 防符号链接逃逸 + DEFAULT_DENY 对
 * .env 与密钥文件的拒绝),这里不自造第二套规则。
 */

/** 预览上限:比模型 read 的 400KB 略宽,超限不做部分读取(首版从简)。 */
const MAX_PREVIEW_BYTES = 512_000;

export type FileReadFailure = 'not-found' | 'binary' | 'too-large' | 'denied' | 'is-directory';

export interface FileContent {
  ok: boolean;
  reason?: FileReadFailure;
  /** 相对工作区的 posix 路径(解析后);失败时回显请求原文。 */
  path: string;
  content?: string;
  /** 文件字节数(拿得到 stat 时);失败路径为 0。 */
  size: number;
  truncated: boolean;
}

export async function readWorkspaceFile(
  root: string,
  file: string,
  denyPath?: string[],
): Promise<FileContent> {
  const fail = (reason: FileReadFailure, size = 0): FileContent => ({
    ok: false,
    reason,
    path: file,
    size,
    truncated: false,
  });

  let resolved;
  try {
    resolved = await resolveInsideWorkspace(file, { root, denyPath });
  } catch (err) {
    if (err instanceof SandboxError) return fail('denied');
    throw err;
  }

  let stat;
  try {
    stat = await fs.stat(resolved.absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fail('not-found');
    throw err;
  }
  if (stat.isDirectory()) return fail('is-directory');
  if (stat.size > MAX_PREVIEW_BYTES) return fail('too-large', stat.size);

  const buffer = await fs.readFile(resolved.absolute);
  if (looksBinary(buffer)) return fail('binary', stat.size);

  return {
    ok: true,
    path: resolved.relative,
    content: buffer.toString('utf8'),
    size: stat.size,
    truncated: false,
  };
}
