/**
 * 界面几何状态(zustand):侧栏宽度与折叠。与业务 store 分开——这些只关乎
 * 本机布局偏好,持久化走 localStorage(width/collapsed 各一个 key)。
 */

import { create } from 'zustand';
import {
  SIDEBAR_DEFAULT_WIDTH,
  clampSidebarWidth,
  loadSidebarCollapsed,
  loadSidebarWidth,
  saveSidebarCollapsed,
  saveSidebarWidth,
} from '../utils/sidebar.js';

export interface UiStore {
  width: number;
  collapsed: boolean;
  /** 拖拽中直接设宽(已钳制);拖拽结束才落盘。 */
  setWidth(width: number, viewportWidth: number): void;
  /** 拖拽结束:持久化当前宽度。 */
  commitWidth(): void;
  /** 双击手柄:复位默认宽并落盘。 */
  resetWidth(): void;
  toggleCollapsed(): void;
}

export const useUiStore = create<UiStore>((set, get) => ({
  width: typeof window === 'undefined' ? SIDEBAR_DEFAULT_WIDTH : loadSidebarWidth(window.innerWidth),
  collapsed: loadSidebarCollapsed(),

  setWidth: (width, viewportWidth) => set({ width: clampSidebarWidth(width, viewportWidth) }),
  commitWidth: () => saveSidebarWidth(get().width),
  resetWidth: () => {
    set({ width: SIDEBAR_DEFAULT_WIDTH });
    saveSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  },
  toggleCollapsed: () => {
    const collapsed = !get().collapsed;
    set({ collapsed });
    saveSidebarCollapsed(collapsed);
  },
}));
