/**
 * 会话级全局状态(zustand),多任务分片:per-task 运行时(runtimes)按
 * taskId 分桶,顶层的 snapshot/connection/permission 是**聚焦任务的镜像**
 * ——组件继续读顶层字段,不感知分桶;聚焦切换时镜像整体换源。
 * 两个 store(本店 + timelineStore)都由 bridge/client.ts 从桥事件驱动。
 */

import { create } from 'zustand';
import type { PermissionRequest } from '@core/events';
import type { StateSnapshot } from '@core/protocol';
import type { ConnectionState, TaskSummary } from '../../shared/ipc.js';

export interface TaskRuntime {
  snapshot: StateSnapshot | undefined;
  connection: ConnectionState;
  permission: PermissionRequest | undefined;
  /** 后台任务的未读标记(turn-end 置位,聚焦清零;P8 接入)。 */
  unread: boolean;
}

const emptyRuntime = (): TaskRuntime => ({
  snapshot: undefined,
  connection: 'connecting',
  permission: undefined,
  unread: false,
});

export interface DesktopStore {
  /** 聚焦任务的镜像(组件的主要读取面)。 */
  connection: ConnectionState;
  snapshot: StateSnapshot | undefined;
  permission: PermissionRequest | undefined;
  /** 任务列表(tasks 通道全量推)。undefined = 尚未收到/读取失败(降级提示)。 */
  tasks: TaskSummary[] | undefined;
  focusedTaskId: string | undefined;
  runtimes: Record<string, TaskRuntime>;
  /** 模型菜单的外部触发计数(/models 命令 → Composer 工具栏的菜单打开),每次 +1。 */
  modelMenuRequest: number;
  /** Composer 预填请求(「请求修改」等):nonce 变化时 Composer 取 text 填入并聚焦。 */
  composerPrefill: { text: string; nonce: number } | undefined;

  applyState(taskId: string, snapshot: StateSnapshot): void;
  applyConnection(taskId: string, connection: ConnectionState): void;
  applyPermission(taskId: string, permission: PermissionRequest | undefined): void;
  applyTasks(tasks: TaskSummary[] | undefined): void;
  /** 聚焦切换:换源顶层镜像(不发 IPC——那是调用方 focusTask 动作的事)。 */
  setFocused(taskId: string | undefined): void;
  requestModelsMenu(): void;
  requestComposerPrefill(text: string): void;
}

/** 从分桶重导出聚焦镜像(聚焦任务缺桶时给安全空值)。 */
function mirrorOf(
  runtimes: Record<string, TaskRuntime>,
  focusedTaskId: string | undefined,
): Pick<DesktopStore, 'connection' | 'snapshot' | 'permission'> {
  const runtime = focusedTaskId ? runtimes[focusedTaskId] : undefined;
  return {
    connection: runtime?.connection ?? 'connecting',
    snapshot: runtime?.snapshot,
    permission: runtime?.permission,
  };
}

export const useDesktopStore = create<DesktopStore>((set) => {
  const patchRuntime = (taskId: string, patch: Partial<TaskRuntime>) =>
    set((state) => {
      const runtimes = {
        ...state.runtimes,
        [taskId]: { ...(state.runtimes[taskId] ?? emptyRuntime()), ...patch },
      };
      return { runtimes, ...mirrorOf(runtimes, state.focusedTaskId) };
    });

  return {
    connection: 'connecting',
    snapshot: undefined,
    permission: undefined,
    tasks: undefined,
    focusedTaskId: undefined,
    runtimes: {},
    modelMenuRequest: 0,
    composerPrefill: undefined,

    applyState: (taskId, snapshot) => patchRuntime(taskId, { snapshot }),
    applyConnection: (taskId, connection) => patchRuntime(taskId, { connection }),
    applyPermission: (taskId, permission) => patchRuntime(taskId, { permission }),
    applyTasks: (tasks) => set({ tasks }),
    setFocused: (focusedTaskId) =>
      set((state) => ({ focusedTaskId, ...mirrorOf(state.runtimes, focusedTaskId) })),
    requestModelsMenu: () => set((state) => ({ modelMenuRequest: state.modelMenuRequest + 1 })),
    requestComposerPrefill: (text) =>
      set((state) => ({
        composerPrefill: { text, nonce: (state.composerPrefill?.nonce ?? 0) + 1 },
      })),
  };
});
