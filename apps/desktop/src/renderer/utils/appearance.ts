/**
 * 外观偏好(设置页·外观节):界面字号。持久化走 localStorage(本机布局
 * 偏好,与侧栏宽度同一层级),应用方式是改 `:root` 的 `--ui-font-size`
 * token——base.less 里 body 的 font-size 吃它,组件内的相对字号跟着缩放。
 * 主题目前只有深色(tokens.less 硬编码),设置页里以禁用项如实呈现。
 */

import { readLocal, writeLocal } from './host.js';

const FONT_SIZE_KEY = 'mojocode.uiFontSize';

export const UI_FONT_SIZE_DEFAULT = 14;
export const UI_FONT_SIZE_MIN = 12;
export const UI_FONT_SIZE_MAX = 18;

export function clampUiFontSize(value: number): number {
  if (!Number.isFinite(value)) return UI_FONT_SIZE_DEFAULT;
  return Math.min(UI_FONT_SIZE_MAX, Math.max(UI_FONT_SIZE_MIN, Math.round(value)));
}

export function loadUiFontSize(): number {
  const raw = readLocal(FONT_SIZE_KEY);
  if (raw === null) return UI_FONT_SIZE_DEFAULT;
  return clampUiFontSize(Number(raw));
}

/** 应用到文档根(main.tsx 启动时与设置页调整时共用);无 DOM 环境(Node 测试)静默跳过。 */
export function applyUiFontSize(size: number): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--ui-font-size', `${clampUiFontSize(size)}px`);
}

export function saveUiFontSize(size: number): void {
  writeLocal(FONT_SIZE_KEY, String(clampUiFontSize(size)));
}

/** 启动时恢复持久化的字号(默认值时不写内联样式,保持 stylesheet 原值)。 */
export function initUiFontSize(): void {
  const size = loadUiFontSize();
  if (size !== UI_FONT_SIZE_DEFAULT) applyUiFontSize(size);
}

/**
 * 代码字号档(设置页·外观的三档:紧凑 11 / 标准 12 / 宽松 14)。应用方式是
 * 给 `:root` 打 `data-font-scale`,tokens.less 里按属性选择器覆盖 --fs-code
 * ——diff / 终端 / 工具输出等等宽区域统一跟着走,界面字号(--ui-font-size)
 * 与它正交,各管各的。
 */

const CODE_SCALE_KEY = 'mojocode.codeFontScale';

export type CodeFontScale = 'compact' | 'standard' | 'relaxed';

export const CODE_FONT_SCALES: CodeFontScale[] = ['compact', 'standard', 'relaxed'];

export function loadCodeFontScale(): CodeFontScale {
  const raw = readLocal(CODE_SCALE_KEY);
  return raw === 'compact' || raw === 'relaxed' ? raw : 'standard';
}

export function applyCodeFontScale(scale: CodeFontScale): void {
  if (typeof document === 'undefined') return;
  if (scale === 'standard') document.documentElement.removeAttribute('data-font-scale');
  else document.documentElement.setAttribute('data-font-scale', scale);
}

export function saveCodeFontScale(scale: CodeFontScale): void {
  writeLocal(CODE_SCALE_KEY, scale);
}

/** 启动时恢复(标准档不写属性,保持 stylesheet 原值)。 */
export function initCodeFontScale(): void {
  applyCodeFontScale(loadCodeFontScale());
}
