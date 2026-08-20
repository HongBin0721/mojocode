/**
 * 界面状态(zustand):视图状态机 + 侧栏几何。
 *
 * 视图:home(首页)/ task(任务工作区)/ archive(归档)/ settings(全屏
 * 设置,覆盖态——returnView 记录来处,关闭回去)。task 视图另有两个正交
 * 维度:taskLayout(chat = 三栏 / review = 右面板全宽评审)与 rightTab
 * (右面板三 tab)。全部不持久化——重启回到任务工作区。
 * 侧栏宽度/折叠持久化走 localStorage(utils/sidebar.ts)。
 */

import { create } from 'zustand';
import {
  PANEL_DEFAULT_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  clampPanelWidth,
  clampSidebarWidth,
  loadPanelWidth,
  loadSidebarCollapsed,
  loadSidebarWidth,
  savePanelWidth,
  saveSidebarCollapsed,
  saveSidebarWidth,
} from '../utils/sidebar.js';

/** 设置页的三节(常规 / 外观 / 模型设置)。 */
export type SettingsSection = 'general' | 'appearance' | 'models';

export type View = 'home' | 'task' | 'archive' | 'settings';
export type TaskLayout = 'chat' | 'review';
export type RightTab = 'diff' | 'terminal' | 'files';

export interface UiStore {
  width: number;
  collapsed: boolean;
  /**
   * 右侧面板宽度。此前是 RightPanel 组件本地 state(切视图即丢),而侧栏
   * 宽度在这里——同一类几何状态两套归属;入 store 后持久化对齐,且钳制
   * 可以从 store 读侧栏实宽,杀掉两处跨组件 DOM 反查(RightPanel 量
   * .sidebar / SidebarResizer 量 .right-panel)。
   */
  panelWidth: number;
  /** 侧栏搜索框的展开态(⌘K 与侧栏搜索行共用,不持久化)。 */
  searchOpen: boolean;
  /**
   * 项目树的视图状态(root → 值;缺省 = 展开 / 只露前 5 条)。放 store 而非
   * 组件内存:⌘B 折叠侧栏、进设置页都会卸载 ProjectTree,手动折起的项目
   * 不该因此自己弹开。会话级,不持久化。
   */
  projectExpanded: Record<string, boolean>;
  projectShowAll: Record<string, boolean>;
  view: View;
  /** settings 是覆盖态:记录来处,closeSettings 回去。 */
  returnView: Exclude<View, 'settings'>;
  /** task 视图布局:三栏聊天 或 右面板全宽评审。 */
  taskLayout: TaskLayout;
  /** 右侧面板当前 tab。 */
  rightTab: RightTab;
  settingsSection: SettingsSection;

  /** 拖拽中直接设宽(已钳制);拖拽结束才落盘。 */
  setWidth(width: number, viewportWidth: number, reserved?: number): void;
  /** 拖拽结束:持久化当前宽度。 */
  commitWidth(): void;
  /** 双击手柄:复位默认宽并落盘。 */
  resetWidth(): void;
  /** 面板拖宽(已钳制:240~720 且给会话区留最小宽,侧栏实宽从本 store 读)。 */
  setPanelWidth(width: number, viewportWidth: number): void;
  /** 面板拖拽结束:持久化当前宽度。 */
  commitPanelWidth(): void;
  toggleCollapsed(): void;
  openSearch(): void;
  closeSearch(): void;
  setProjectExpanded(root: string, open: boolean): void;
  setProjectShowAll(root: string, on: boolean): void;
  /** 主导航(首页/任务/归档)。进 task 时布局回到 chat。 */
  navigate(view: Exclude<View, 'settings'>): void;
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  setSettingsSection(section: SettingsSection): void;
  /** 评审全宽 ⇄ 三栏聊天(标题栏/面板头按钮)。 */
  toggleReviewLayout(): void;
  setRightTab(tab: RightTab): void;
}

export const useUiStore = create<UiStore>((set, get) => ({
  width: typeof window === 'undefined' ? SIDEBAR_DEFAULT_WIDTH : loadSidebarWidth(window.innerWidth),
  collapsed: loadSidebarCollapsed(),
  panelWidth: typeof window === 'undefined' ? PANEL_DEFAULT_WIDTH : loadPanelWidth(),
  searchOpen: false,
  projectExpanded: {},
  projectShowAll: {},
  view: 'task',
  returnView: 'task',
  taskLayout: 'chat',
  rightTab: 'diff',
  settingsSection: 'general',

  setWidth: (width, viewportWidth, reserved) =>
    set({ width: clampSidebarWidth(width, viewportWidth, reserved) }),
  commitWidth: () => saveSidebarWidth(get().width),
  resetWidth: () => {
    set({ width: SIDEBAR_DEFAULT_WIDTH });
    saveSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  },
  setPanelWidth: (width, viewportWidth) => {
    const state = get();
    const sidebarWidth = state.collapsed ? 0 : state.width;
    set({ panelWidth: clampPanelWidth(width, viewportWidth, sidebarWidth) });
  },
  commitPanelWidth: () => savePanelWidth(get().panelWidth),
  toggleCollapsed: () => {
    const collapsed = !get().collapsed;
    set({ collapsed });
    saveSidebarCollapsed(collapsed);
  },
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
  setProjectExpanded: (root, open) =>
    set((state) => ({ projectExpanded: { ...state.projectExpanded, [root]: open } })),
  setProjectShowAll: (root, on) =>
    set((state) => ({ projectShowAll: { ...state.projectShowAll, [root]: on } })),

  navigate: (view) => set({ view, ...(view === 'task' ? { taskLayout: 'chat' } : {}) }),
  openSettings: (section) =>
    set((state) => ({
      view: 'settings',
      // 从非 settings 视图进入时记录来处;settings 内切节不覆盖。
      ...(state.view !== 'settings' ? { returnView: state.view as Exclude<View, 'settings'> } : {}),
      settingsSection: section ?? state.settingsSection,
    })),
  closeSettings: () => set((state) => ({ view: state.returnView })),
  setSettingsSection: (section) => set({ settingsSection: section }),
  toggleReviewLayout: () =>
    set((state) => ({ taskLayout: state.taskLayout === 'chat' ? 'review' : 'chat' })),
  setRightTab: (tab) => set({ rightTab: tab }),
}));
