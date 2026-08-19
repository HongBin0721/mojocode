/**
 * 侧栏几何的纯函数:宽度钳制(ZCode:默认 264,下限 264,上限 50vw)与
 * localStorage 序列化(经 host.ts 的 readLocal/writeLocal,兜底在那边)。
 * 抽出来是为了单测锁定,组件只做拖拽接线。
 */

import { readLocal, writeLocal } from './host.js';

export const SIDEBAR_DEFAULT_WIDTH = 264;
export const SIDEBAR_WIDTH_KEY = 'mojocode.sidebar-width';
export const SIDEBAR_COLLAPSED_KEY = 'mojocode.sidebar-collapsed';

/** 中间会话区的最小可用宽:两侧拖宽的上限都要给它留位(CSS 同值兜底)。 */
export const CHAT_MIN_WIDTH = 360;

/**
 * 拖宽钳制:264 起,上限为窗口宽的一半(ZCode 的 max 50vw);传 reserved
 * (右面板当前占宽)时再收紧到「不把中间区压破 CHAT_MIN_WIDTH」。
 */
export function clampSidebarWidth(width: number, viewportWidth: number, reserved = 0): number {
  const max = Math.max(
    SIDEBAR_DEFAULT_WIDTH,
    Math.min(Math.floor(viewportWidth / 2), Math.floor(viewportWidth - reserved - CHAT_MIN_WIDTH)),
  );
  const clamped = Math.min(max, Math.max(SIDEBAR_DEFAULT_WIDTH, Math.round(width)));
  return Number.isFinite(clamped) ? clamped : SIDEBAR_DEFAULT_WIDTH;
}

/** 读取持久化宽度;非法/缺失回默认。 */
export function loadSidebarWidth(viewportWidth: number): number {
  const raw = readLocal(SIDEBAR_WIDTH_KEY);
  if (raw === null) return SIDEBAR_DEFAULT_WIDTH;
  const value = Number(raw);
  if (!Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH;
  return clampSidebarWidth(value, viewportWidth);
}

export function saveSidebarWidth(width: number): void {
  writeLocal(SIDEBAR_WIDTH_KEY, String(width));
}

export function loadSidebarCollapsed(): boolean {
  return readLocal(SIDEBAR_COLLAPSED_KEY) === '1';
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  writeLocal(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
}

/* ---- 右侧面板宽度(与侧栏同一套「钳制纯函数 + localStorage 序列化」) ---- */

export const PANEL_DEFAULT_WIDTH = 480;
export const PANEL_MIN_WIDTH = 240;
export const PANEL_MAX_WIDTH = 720;
export const PANEL_WIDTH_KEY = 'mojocode.panel-width';

/**
 * 面板拖宽钳制:240~720,且给中间会话区留 CHAT_MIN_WIDTH(sidebarWidth 是
 * 侧栏当前占宽,折叠时传 0)。窗口极窄时上限压不过 240 下限——CSS 端由
 * 面板先收缩兜底(与拆分前 RightPanel 内联逻辑等价)。
 */
export function clampPanelWidth(width: number, viewportWidth: number, sidebarWidth: number): number {
  const limit = Math.max(
    PANEL_MIN_WIDTH,
    Math.min(PANEL_MAX_WIDTH, viewportWidth - sidebarWidth - CHAT_MIN_WIDTH),
  );
  const clamped = Math.min(limit, Math.max(PANEL_MIN_WIDTH, Math.round(width)));
  return Number.isFinite(clamped) ? clamped : PANEL_DEFAULT_WIDTH;
}

/** 读取持久化面板宽;非法/缺失回默认(不在读取时钳制——视口相关,渲染时钳)。 */
export function loadPanelWidth(): number {
  const raw = readLocal(PANEL_WIDTH_KEY);
  if (raw === null) return PANEL_DEFAULT_WIDTH;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : PANEL_DEFAULT_WIDTH;
}

export function savePanelWidth(width: number): void {
  writeLocal(PANEL_WIDTH_KEY, String(width));
}
