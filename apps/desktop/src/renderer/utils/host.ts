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
    length: number;
    key(index: number): string | null;
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

/** 主进程平台('darwin' 等);桥未注入(测试环境)回 'unknown',不抛。 */
export function platform(): string {
  return host().mojocode?.platform ?? 'unknown';
}

/**
 * 偏好缓存:桥在场时以 preload 的 gui.json 快照为底(写走 prefs.set,主进程
 * 落盘 ~/.mojocode/gui.json),此后读写都打这份内存副本——set 是 fire-and-
 * forget,快照不会自己更新。首次初始化时把当前 origin localStorage 里的历史
 * mojocode.* 键一次性收编进落盘:旧版把偏好写在 localStorage,其位置是
 * userData 目录 × origin,dev(localhost)与构建产物(file://)各存一份,
 * 互不相通——这是"导入的项目重启后消失"的事故来源。
 *
 * 桥缺席(Node/组件测试、浏览器)时不缓存,逐次退回 localStorage,保持
 * 测试可用真实 Storage 断言往返。
 */
let prefsCache: Record<string, string> | undefined;

function prefsStore(): Record<string, string> | null {
  if (prefsCache !== undefined) return prefsCache;
  const api = host().mojocode;
  if (!api?.prefs) return null;
  const cache: Record<string, string> = { ...api.prefs.snapshot };
  try {
    const ls = host().localStorage;
    if (ls) {
      for (let i = 0; i < ls.length; i++) {
        const key = ls.key(i);
        if (!key?.startsWith('mojocode.') || cache[key] !== undefined) continue;
        const value = ls.getItem(key);
        if (value !== null) {
          cache[key] = value;
          api.prefs.set(key, value);
        }
      }
    }
  } catch {
    // 迁移失败不影响本次会话。
  }
  prefsCache = cache;
  return cache;
}

/** 读本机偏好;不可用(隐私模式/测试环境)或解析失败时回 null。 */
export function readLocal(key: string): string | null {
  const prefs = prefsStore();
  if (prefs) return prefs[key] ?? null;
  try {
    return host().localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** 写本机偏好;失败静默——持久化不该影响本次会话。 */
export function writeLocal(key: string, value: string): void {
  const prefs = prefsStore();
  if (prefs) {
    prefs[key] = value;
    host().mojocode?.prefs.set(key, value);
    return;
  }
  try {
    host().localStorage?.setItem(key, value);
  } catch {
    // 忽略:配额/隐私模式。
  }
}
