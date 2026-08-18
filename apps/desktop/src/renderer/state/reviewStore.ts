/**
 * Review 面板状态:pending 变更列表(workspaceStatus)+ 按需加载的单文件
 * diff 缓存 + 行评论目标。刷新点事件化(面板可见/窗口 focus/轮次结束/
 * 手动),不做轮询;旧 server(unknown method)降级为 unsupported。
 */

import { create } from 'zustand';
import type { FileDiffSummary, GitOpSummary, WorkspaceStatusSummary } from '../../shared/ipc.js';
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

/** diff 面板批准流(设计稿):批准并提交 → committed → 撤销/新变更回落。 */
export type ApprovalState = 'idle' | 'committing' | 'committed' | 'undoing';

export interface ReviewStore {
  visible: boolean;
  /** undefined = 尚未加载;ok:false = 非 git 仓库。 */
  status: WorkspaceStatusSummary | undefined;
  /** server 过旧(unknown method)。 */
  unsupported: boolean;
  fileDiffs: Record<string, FileDiffSummary>;
  loadingPaths: Record<string, boolean>;
  /** 文件条单选(设计稿):当前查看 diff 的文件。 */
  selectedPath: string | undefined;
  commentTarget: CommentTarget | undefined;
  approval: ApprovalState;
  /** committed 态展示「已提交到 {branch}」。 */
  lastCommit: { branch?: string } | undefined;
  /** 批准/撤销/丢弃失败的一行提示(英文 detail 原样)。 */
  approvalError: string | undefined;

  setVisible(visible: boolean): void;
  toggleVisible(): void;
  /** 拉取 pending 列表;并发调用合并成一次扫描(见 inflight/dirty)。 */
  refresh(): Promise<void>;
  /** 切工作区:丢掉属于旧 root 的全部缓存(状态/diff/选中/评论目标)。 */
  reset(): void;
  /** 选中文件(无缓存则加载 diff)。 */
  selectFile(path: string): void;
  setCommentTarget(target: CommentTarget | undefined): void;
  /** 批准并提交(git add -A + commit);成功进入 committed。 */
  approve(message: string): Promise<void>;
  /** 撤销上一个提交(soft reset),回到 pending。 */
  undoApprove(): Promise<void>;
  /** 丢弃全部变更(调用方先弹确认)。 */
  discardAll(): Promise<void>;
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
  selectedPath: undefined,
  commentTarget: undefined,
  approval: 'idle',
  lastCommit: undefined,
  approvalError: undefined,

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
        const state = get();
        // 不变量:又出现了新 pending 时,「已提交」横幅必须回落——不能盖住新变更。
        if (state.approval === 'committed' && status.ok && status.entries.length > 0) {
          set({ approval: 'idle', lastCommit: undefined });
        }
        // 选中文件已不在列表里(被提交/丢弃):清空选中与它的旧 diff 缓存。
        if (state.selectedPath && !status.entries.some((e) => e.path === state.selectedPath)) {
          set({ selectedPath: undefined, commentTarget: undefined });
        }
        // diff 缓存按扫描代际失效:上一轮的 diff 可能已过期(文件又被改过)。
        set({ fileDiffs: {}, loadingPaths: {} });
        const path = get().selectedPath;
        if (path) get().selectFile(path);
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
    // 同名文件会直接命中旧 diff),连同选中与评论目标一起清掉。
    dirty = false;
    set({
      status: undefined,
      unsupported: false,
      fileDiffs: {},
      loadingPaths: {},
      selectedPath: undefined,
      commentTarget: undefined,
      approval: 'idle',
      lastCommit: undefined,
      approvalError: undefined,
    });
  },

  selectFile: (path) => {
    const { fileDiffs, loadingPaths } = get();
    set({ selectedPath: path, commentTarget: undefined });
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

  approve: async (message) => {
    if (get().approval !== 'idle') return;
    set({ approval: 'committing', approvalError: undefined });
    try {
      const result = (await bridgeApi().rpc({ kind: 'commitAll', message })) as GitOpSummary;
      if (result.ok) {
        set({ approval: 'committed', lastCommit: { branch: get().status?.branch } });
        await get().refresh();
      } else {
        set({ approval: 'idle', approvalError: result.detail ?? result.reason ?? 'commit failed' });
      }
    } catch (error) {
      set({ approval: 'idle', approvalError: error instanceof Error ? error.message : String(error) });
    }
  },

  undoApprove: async () => {
    if (get().approval !== 'committed') return;
    set({ approval: 'undoing' });
    try {
      const result = (await bridgeApi().rpc({ kind: 'undoCommit' })) as GitOpSummary;
      if (!result.ok) {
        set({ approvalError: result.detail ?? result.reason ?? 'undo failed' });
      }
    } catch (error) {
      set({ approvalError: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ approval: 'idle', lastCommit: undefined });
      await get().refresh();
    }
  },

  discardAll: async () => {
    set({ approvalError: undefined });
    try {
      const result = (await bridgeApi().rpc({ kind: 'discardAll' })) as GitOpSummary;
      if (!result.ok && result.reason !== 'no-repo') {
        set({ approvalError: result.detail ?? result.reason ?? 'discard failed' });
      }
    } catch (error) {
      set({ approvalError: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ approval: 'idle', lastCommit: undefined });
      await get().refresh();
    }
  },
}));
