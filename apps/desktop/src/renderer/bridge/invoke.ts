/**
 * 上行 RPC 的唯一入口层(与下行的 client.ts 对称):类型化转发 + 统一错误
 * 出口 + 协议降级判定。组件/store 一律经 rpcCall / rpcFire 调用,不再裸摸
 * `window.mojocode`——错误从 12 个文件各自的 console.error 收拢到 notice
 * (用户可见)。bridgeApi() 每次调用现取,禁止模块顶层缓存:测试在
 * beforeEach 里重赋 `window.mojocode` mock,缓存引用会拿到上一个用例的桩。
 */

import { t, type MessageKey } from '../i18n/index.js';
import { bridgeApi } from '../utils/host.js';
import { pushNotice } from '../state/noticeStore.js';
import type { RpcRequest, RpcResult } from '../../shared/ipc.js';

/** 错误摘要(Electron invoke 的 rejection 是 Error,message 过 IPC 保留)。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 旧 server 协议降级判定(unknown method)。必须 includes 不能全等:
 * Electron 的 invoke rejection 带 `Error invoking remote method 'bridge:rpc':`
 * 前缀。
 */
export function isUnknownMethodError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('unknown method');
}

/** 类型化 RPC:错误原样上抛,调用方自己消化(局部 error chip / store 降级)。 */
export function rpcCall<R extends RpcRequest>(
  request: R,
  taskId?: string,
): Promise<RpcResult<R['kind']>> {
  return bridgeApi().rpc(request, taskId);
}

/** fire-and-forget RPC:失败统一进 notice(i18n 文案 + 端点原始 message)。 */
export function rpcFire<R extends RpcRequest>(
  request: R,
  opts?: { taskId?: string; errorKey?: MessageKey },
): void {
  void bridgeApi()
    .rpc(request, opts?.taskId)
    .catch((error: unknown) => {
      pushNotice('error', `${t(opts?.errorKey ?? 'notice.rpcFailed')}: ${describeError(error)}`);
    });
}

/** 非 RPC 的桥方法 fire-and-forget 包装(Finder 显示 / 系统程序打开)。 */
export function revealPath(path: string): void {
  void bridgeApi()
    .revealPath(path)
    .catch((error: unknown) => {
      pushNotice('error', `${t('notice.revealFailed')}: ${describeError(error)}`);
    });
}

export function openPath(path: string): void {
  void bridgeApi()
    .openPath(path)
    .catch((error: unknown) => {
      pushNotice('error', `${t('notice.openFileFailed')}: ${describeError(error)}`);
    });
}
