/**
 * 宿主环境访问器(桥 API 与 localStorage),一律经 globalThis 取值。
 *
 * 为什么不直接写 `window.` / `localStorage.`:renderer 的纯逻辑模块(store、
 * utils)会被 Node 侧的测试项目 typecheck(tsconfig.json 覆盖 main/preload/
 * shared/tests,没有 DOM lib),裸的 DOM 全局名在那边不存在。经 globalThis
 * 取值既保持类型安全(桥 API 的类型来自 shared/api.ts),又让这些模块能在
 * Node 测试环境里被直接 import 与 mock。
 */

import type { MojocodeDesktopApi } from '../../shared/api.js';

interface Host {
  mojocode?: MojocodeDesktopApi;
  localStorage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
}

const host = (): Host => globalThis as Host;

/** 桥 API(preload 经 contextBridge 挂在全局的 `mojocode`)。 */
export function bridgeApi(): MojocodeDesktopApi {
  const api = host().mojocode;
  if (!api) throw new Error('桥 API 尚未注入(preload 未加载?)');
  return api;
}

/** 读本机偏好;不可用(隐私模式/测试环境)或解析失败时回 null。 */
export function readLocal(key: string): string | null {
  try {
    return host().localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** 写本机偏好;失败静默——持久化不该影响本次会话。 */
export function writeLocal(key: string, value: string): void {
  try {
    host().localStorage?.setItem(key, value);
  } catch {
    // 忽略:配额/隐私模式。
  }
}
