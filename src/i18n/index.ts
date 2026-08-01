import { en } from './en.js';
import { zhCN } from './zh-CN.js';

export type Locale = 'en' | 'zh-CN';
export type MessageKey = keyof typeof en;

export const LOCALES: Locale[] = ['en', 'zh-CN'];

const catalogs: Record<Locale, Record<MessageKey, string>> = {
  en,
  'zh-CN': zhCN,
};

/**
 * 解析顺序:显式偏好(配置项 `language`)> KDG_LANG > LC_ALL >
 * LC_MESSAGES > LANG。任何 `zh*` 值都映射到 zh-CN;其余一律回退到英文。
 */
export function detectLocale(pref?: string, env: NodeJS.ProcessEnv = process.env): Locale {
  if (pref && isLocale(pref)) return pref;
  const raw = env.KDG_LANG ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? '';
  return /^zh/i.test(raw) ? 'zh-CN' : 'en';
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as string[]).includes(value);
}

// 在 import 时就按环境变量检测,使模块加载时求值的字符串(commander 帮助)
// 已经是本地化的。之后配置或 `/lang` 会通过 setLocale() 覆盖。
let current: Locale = detectLocale();

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

/** 在当前语言目录中查找 `key`,并填充 `{name}` 占位符。 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = catalogs[current][key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
