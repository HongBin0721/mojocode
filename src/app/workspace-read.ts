import fs from 'node:fs/promises';
import path from 'node:path';
import { looksBinary } from '../tools/files.js';

/**
 * GUI 文件预览的读取器(`readFile` RPC 的实现)。必须跑在 server 侧:
 * `--attach` 场景下仓库在 server 那台机器,GUI 直接读盘读不到。
 *
 * 失败一律以 reason 码返回、不抛异常(FileDiff 的先例)——GUI 好渲染灰态。
 * 这是一个 HTTP 端点(`GET` 语义的 RPC),`denied` 只挡路径穿越出工作区——
 * 它是端点自己的边界,与 agent 的工具无关(那些没有围栏,Pi 式)。
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

export async function readWorkspaceFile(root: string, file: string): Promise<FileContent> {
  const fail = (reason: FileReadFailure, size = 0): FileContent => ({
    ok: false,
    reason,
    path: file,
    size,
    truncated: false,
  });

  // realpath 之后再比对:工作区内的符号链接可以指向工作区之外,只比字面
  // 路径拦不住穿越。不存在的目标 realpath 会 ENOENT,顺手就是 not-found。
  let realRoot: string;
  let absolute: string;
  try {
    realRoot = await fs.realpath(root);
    absolute = await fs.realpath(path.resolve(root, file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fail('not-found');
    throw err;
  }
  const rel = path.relative(realRoot, absolute);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return fail('denied');
  const resolved = { absolute, relative: rel.split(path.sep).join('/') };

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
