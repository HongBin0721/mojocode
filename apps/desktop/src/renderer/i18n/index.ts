/**
 * GUI 的 renderer 侧 i18n。结构与根仓库的 src/i18n 同款(MessageKey 从 en
 * 目录推导、t(key, params) 填充 {name} 占位符),但**独立目录**:
 *  - 根 i18n 在模块加载期读 process.env(renderer 无 process);
 *  - 不该把整套 TUI 文案打进 GUI bundle。
 *
 * reducer 移植(timelineReducer)用到的 notice.* key 与根目录同 key 同参,
 * 文案保持一致——两边的行为语义是 1:1 的。
 *
 * locale 存 localStorage(与 TUI 共享偏好的持久化在 M4 接 config.language)。
 */

import { useSyncExternalStore } from 'react';
import { readLocal, writeLocal } from '../utils/host.js';
import { en } from './en.js';
import { zhCN } from './zh-CN.js';

export type Locale = 'en' | 'zh-CN';
export type MessageKey = keyof typeof en;

const STORAGE_KEY = 'mojocode.locale';

function detectLocale(): Locale {
  // readLocal 内置兜底(极端隐私设置/非浏览器环境回 null)——退回系统语言。
  const stored = readLocal(STORAGE_KEY);
  if (stored === 'en' || stored === 'zh-CN') return stored;
  // node 测试环境没有 navigator:回退英文(reducer 的 notice 文案断言在
  // 测试里显式 setLocale,不依赖这里的检测结果)。
  const language = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return /^zh/i.test(language) ? 'zh-CN' : 'en';
}

let current: Locale = detectLocale();
const listeners = new Set<() => void>();

export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  writeLocal(STORAGE_KEY, locale); // 持久化失败静默,不影响本次切换
  for (const listener of listeners) listener();
}

export function getLocale(): Locale {
  return current;
}

/** 语言切换的通知(React 侧经 useLocale 订阅;reducer 直接读 t() 的 current)。 */
export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 语言变化的 React 钩子:切换时静态文案整体重算。 */
export function useLocale(): Locale {
  return useSyncExternalStore(onLocaleChange, getLocale, getLocale);
}

/** 在当前语言目录中查找 key,并填充 {name} 占位符。 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const catalogs: Record<Locale, Record<MessageKey, string>> = { en, 'zh-CN': zhCN };
  const template = catalogs[current][key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
