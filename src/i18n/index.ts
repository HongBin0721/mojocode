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
 * Resolution order: explicit preference (config `language`) > KDG_LANG >
 * LC_ALL > LC_MESSAGES > LANG. Any `zh*` value maps to zh-CN; everything else
 * falls back to English.
 */
export function detectLocale(pref?: string, env: NodeJS.ProcessEnv = process.env): Locale {
  if (pref && isLocale(pref)) return pref;
  const raw = env.KDG_LANG ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? '';
  return /^zh/i.test(raw) ? 'zh-CN' : 'en';
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as string[]).includes(value);
}

// Env-detected at import so strings evaluated at module load (commander help)
// are already localized. Config/`/lang` override it later via setLocale().
let current: Locale = detectLocale();

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

/** Looks up `key` in the active catalog and fills `{name}` placeholders. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = catalogs[current][key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
