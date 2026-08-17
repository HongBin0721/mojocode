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

/** 设置页的三节(ZCode 形态:常规 / 外观 / 模型设置)。 */
export type SettingsSection = 'general' | 'appearance' | 'models';

export interface UiStore {
  width: number;
  collapsed: boolean;
  /** 侧栏搜索框的展开态(⌘K 与侧栏搜索行共用,不持久化)。 */
  searchOpen: boolean;
  /** 当前视图:聊天工作区或全屏设置页(侧栏底部设置按钮进入)。不持久化——
   * 设置页是临时驻留,重启回到工作区。 */
  view: 'chat' | 'settings';
  settingsSection: SettingsSection;
  /** 拖拽中直接设宽(已钳制);拖拽结束才落盘。 */
  setWidth(width: number, viewportWidth: number): void;
  /** 拖拽结束:持久化当前宽度。 */
  commitWidth(): void;
  /** 双击手柄:复位默认宽并落盘。 */
  resetWidth(): void;
  toggleCollapsed(): void;
  openSearch(): void;
  closeSearch(): void;
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  setSettingsSection(section: SettingsSection): void;
}

export const useUiStore = create<UiStore>((set, get) => ({
  width: typeof window === 'undefined' ? SIDEBAR_DEFAULT_WIDTH : loadSidebarWidth(window.innerWidth),
  collapsed: loadSidebarCollapsed(),
  searchOpen: false,

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
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),

  view: 'chat',
  settingsSection: 'general',
  openSettings: (section) =>
    set((state) => ({ view: 'settings', settingsSection: section ?? state.settingsSection })),
  closeSettings: () => set({ view: 'chat' }),
  setSettingsSection: (section) => set({ settingsSection: section }),
}));
