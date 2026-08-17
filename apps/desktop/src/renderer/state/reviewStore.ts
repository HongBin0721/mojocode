/**
 * Review 面板状态:pending 变更列表(workspaceStatus)+ 按需加载的单文件
 * diff 缓存 + 行评论目标。刷新点事件化(面板可见/窗口 focus/轮次结束/
 * 手动),不做轮询;旧 server(unknown method)降级为 unsupported。
 */

import { create } from 'zustand';
import type { FileDiffSummary, WorkspaceStatusSummary } from '../../shared/ipc.js';
import { bridgeApi, readLocal, writeLocal } from '../utils/host.js';

const VISIBLE_KEY = 'mojocode.reviewVisible';

function initialVisible(): boolean {
  return readLocal(VISIBLE_KEY) === '1';
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
  /** 拉取 pending 列表;并发调用合并成一次扫描(见 inflight/dirty)。 */
  refresh(): Promise<void>;
  /** 切工作区:丢掉属于旧 root 的全部缓存(状态/diff/展开态/评论目标)。 */
  reset(): void;
  /** 展开(无缓存则加载 diff)/收起。 */
  toggleFile(path: string): void;
  setCommentTarget(target: CommentTarget | undefined): void;
}

/** 进行中的 refresh(模块级):多个触发点(面板可见/窗口 focus/turn-end/
 * 顶栏分支 chip)彼此不知情,不去重会并发跑 N 份同样的 git 扫描。
 * `dirty`:扫描开跑之后到达的请求不能只是并进来——它要的是**那之后**的
 * 工作区状态(典型:focus 触发的扫描先跑,turn-end 的写入随后落盘),
 * 直接复用旧结果会漏掉本轮改的文件,所以落定后补跑一次。 */
let inflight: Promise<void> | undefined;
let dirty = false;

export const useReviewStore = create<ReviewStore>((set, get) => ({
  visible: initialVisible(),
  status: undefined,
  unsupported: false,
  fileDiffs: {},
  loadingPaths: {},
  expandedPaths: [],
  commentTarget: undefined,

  setVisible: (visible) => {
    writeLocal(VISIBLE_KEY, visible ? '1' : '0');
    set({ visible });
    if (visible) void get().refresh();
  },
  toggleVisible: () => get().setVisible(!get().visible),

  refresh: () => {
    if (inflight) {
      dirty = true;
      return inflight;
    }
    inflight = (async () => {
      try {
        const status = (await bridgeApi().rpc({ kind: 'workspaceStatus' })) as WorkspaceStatusSummary;
        set({ status, unsupported: false });
      } catch (error) {
        // 旧 server:显式降级,面板给出提示而不是反复报错。
        if (error instanceof Error && error.message.includes('unknown method')) {
          set({ unsupported: true, status: undefined });
          return;
        }
        console.error('workspaceStatus 失败', error);
      } finally {
        inflight = undefined;
        if (dirty) {
          dirty = false;
          void get().refresh();
        }
      }
    })();
    return inflight;
  },

  reset: () => {
    // 切工作区:整份缓存都属于旧 root(fileDiffs 按相对路径存,新工作区的
    // 同名文件会直接命中旧 diff),连同展开态与评论目标一起清掉。
    dirty = false;
    set({
      status: undefined,
      unsupported: false,
      fileDiffs: {},
      loadingPaths: {},
      expandedPaths: [],
      commentTarget: undefined,
    });
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
      void bridgeApi()
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
