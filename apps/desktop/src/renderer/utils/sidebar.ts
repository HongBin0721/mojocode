/**
 * 侧栏几何的纯函数:宽度钳制(ZCode:默认 264,下限 264,上限 50vw)与
 * localStorage 序列化。抽出来是为了单测锁定,组件只做拖拽接线。
 */

export const SIDEBAR_DEFAULT_WIDTH = 264;
export const SIDEBAR_WIDTH_KEY = 'mojocode.sidebar-width';
export const SIDEBAR_COLLAPSED_KEY = 'mojocode.sidebar-collapsed';

/** 拖宽钳制:264 起,上限为窗口宽的一半(ZCode 的 max 50vw)。 */
export function clampSidebarWidth(width: number, viewportWidth: number): number {
  const max = Math.max(SIDEBAR_DEFAULT_WIDTH, Math.floor(viewportWidth / 2));
  const clamped = Math.min(max, Math.max(SIDEBAR_DEFAULT_WIDTH, Math.round(width)));
  return Number.isFinite(clamped) ? clamped : SIDEBAR_DEFAULT_WIDTH;
}

/** 读取持久化宽度;非法/缺失回默认。 */
export function loadSidebarWidth(viewportWidth: number): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw === null) return SIDEBAR_DEFAULT_WIDTH;
    const value = Number(raw);
    if (!Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH;
    return clampSidebarWidth(value, viewportWidth);
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function saveSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    // 持久化失败不影响本次会话。
  }
}

export function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // 同上。
  }
}
