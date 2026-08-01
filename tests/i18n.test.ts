import { afterEach, describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en.js';
import { zhCN } from '../src/i18n/zh-CN.js';
import { detectLocale, getLocale, setLocale, t } from '../src/i18n/index.js';

afterEach(() => setLocale('en'));

describe('catalog parity', () => {
  it('zh-CN provides every key en has, and nothing extra', () => {
    const enKeys = Object.keys(en).sort();
    const zhKeys = Object.keys(zhCN).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it('zh-CN keeps the same placeholders as en', () => {
    const placeholders = (text: string) => (text.match(/\{(\w+)\}/g) ?? []).sort();
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(placeholders(zhCN[key]), `placeholders differ for "${key}"`).toEqual(
        placeholders(en[key]),
      );
    }
  });

  it('no catalog entry is empty', () => {
    for (const [key, value] of [...Object.entries(en), ...Object.entries(zhCN)]) {
      expect(value.trim().length, `"${key}" is empty`).toBeGreaterThan(0);
    }
  });
});

describe('detectLocale', () => {
  it('prefers the explicit setting over the environment', () => {
    expect(detectLocale('zh-CN', { LANG: 'en_US.UTF-8' })).toBe('zh-CN');
    expect(detectLocale('en', { LANG: 'zh_CN.UTF-8' })).toBe('en');
  });

  it('maps any zh* environment locale to zh-CN', () => {
    expect(detectLocale(undefined, { LANG: 'zh_CN.UTF-8' })).toBe('zh-CN');
    expect(detectLocale(undefined, { LANG: 'zh_TW.UTF-8' })).toBe('zh-CN');
    expect(detectLocale(undefined, { KDG_LANG: 'zh-CN' })).toBe('zh-CN');
  });

  it('KDG_LANG beats LANG', () => {
    expect(detectLocale(undefined, { KDG_LANG: 'en', LANG: 'zh_CN.UTF-8' })).toBe('en');
  });

  it('falls back to English for anything else', () => {
    expect(detectLocale(undefined, {})).toBe('en');
    expect(detectLocale(undefined, { LANG: 'ja_JP.UTF-8' })).toBe('en');
    expect(detectLocale('auto', { LANG: 'C' })).toBe('en');
  });
});

describe('t', () => {
  it('interpolates parameters', () => {
    expect(t('status.runningTool', { tool: 'bash' })).toBe('running bash');
  });

  it('leaves unknown placeholders intact rather than printing undefined', () => {
    expect(t('status.runningTool', {})).toBe('running {tool}');
  });

  it('switches catalogs with setLocale', () => {
    setLocale('zh-CN');
    expect(getLocale()).toBe('zh-CN');
    expect(t('status.thinking')).toBe('思考中');
    expect(t('notice.modeSet', { mode: 'yolo' })).toBe('权限模式已设为 yolo。');
  });
});
