/**
 * Review 面板状态:pending 变更列表(workspaceStatus)+ 按需加载的单文件
 * diff 缓存 + 行评论目标。刷新点事件化(面板可见/窗口 focus/轮次结束/
 * 手动),不做轮询;旧 server(unknown method)降级为 unsupported。
 */

import { create } from 'zustand';
import type { FileDiffSummary, WorkspaceStatusSummary } from '../../shared/ipc.js';

const VISIBLE_KEY = 'mojocode.reviewVisible';

function initialVisible(): boolean {
  try {
    return localStorage.getItem(VISIBLE_KEY) === '1';
  } catch {
    return false;
  }
}

export interface CommentTarget {
  path: string;
  line: number;
  side: 'old' | 'new';
}

export interface ReviewStore {
  visible: boolean;
  /** undefined = 尚未加载;ok:false = 非 git 仓库。 */
  status: WorkspaceStatusSummary | undefined;
  /** server 过旧(unknown method)。 */
  unsupported: boolean;
  fileDiffs: Record<string, FileDiffSummary>;
  loadingPaths: Record<string, boolean>;
  expandedPaths: string[];
  commentTarget: CommentTarget | undefined;

  setVisible(visible: boolean): void;
  toggleVisible(): void;
  /** 拉取 pending 列表;仅面板可见时才有意义(调用方负责)。 */
  refresh(): Promise<void>;
  /** 展开(无缓存则加载 diff)/收起。 */
  toggleFile(path: string): void;
  setCommentTarget(target: CommentTarget | undefined): void;
}

export const useReviewStore = create<ReviewStore>((set, get) => ({
  visible: initialVisible(),
  status: undefined,
  unsupported: false,
  fileDiffs: {},
  loadingPaths: {},
  expandedPaths: [],
  commentTarget: undefined,

  setVisible: (visible) => {
    try {
      localStorage.setItem(VISIBLE_KEY, visible ? '1' : '0');
    } catch {
      // 持久化失败不影响本次会话。
    }
    set({ visible });
    if (visible) void get().refresh();
  },
  toggleVisible: () => get().setVisible(!get().visible),

  refresh: async () => {
    try {
      const status = (await window.mojocode.rpc({ kind: 'workspaceStatus' })) as WorkspaceStatusSummary;
      set({ status, unsupported: false });
    } catch (error) {
      // 旧 server:显式降级,面板给出提示而不是反复报错。
      if (error instanceof Error && error.message.includes('unknown method')) {
        set({ unsupported: true, status: undefined });
        return;
      }
      console.error('workspaceStatus 失败', error);
    }
  },

  toggleFile: (path) => {
    const { expandedPaths, fileDiffs, loadingPaths } = get();
    if (expandedPaths.includes(path)) {
      set({ expandedPaths: expandedPaths.filter((p) => p !== path), commentTarget: undefined });
      return;
    }
    set({ expandedPaths: [...expandedPaths, path] });
    if (!fileDiffs[path] && !loadingPaths[path]) {
      set({ loadingPaths: { ...loadingPaths, [path]: true } });
      void window.mojocode
        .rpc({ kind: 'fileDiff', path })
        .then((result) => {
          const diff = result as FileDiffSummary;
          set((state) => ({
            fileDiffs: { ...state.fileDiffs, [path]: diff },
            loadingPaths: { ...state.loadingPaths, [path]: false },
          }));
        })
        .catch((error: unknown) => {
          console.error('fileDiff 失败', error);
          set((state) => ({ loadingPaths: { ...state.loadingPaths, [path]: false } }));
        });
    }
  },

  setCommentTarget: (commentTarget) => set({ commentTarget }),
}));
