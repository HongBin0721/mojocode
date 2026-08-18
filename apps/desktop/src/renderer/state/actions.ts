/**
 * renderer 侧的共享动作:把「守卫 + IPC + store 同步」收拢成一份,组件只做
 * 接线。换会话三连已退役——新任务/打开历史一律走 TaskManager 的 task:* 通道。
 */

import { useDesktopStore } from './desktopStore.js';
import { useTimelineStore } from './timelineStore.js';

/** 聚焦一个任务:store 镜像换源 + 通知 main(重推该任务的回放)。 */
export function focusTask(taskId: string): void {
  useDesktopStore.getState().setFocused(taskId);
  useTimelineStore.getState().setFocused(taskId);
  void window.mojocode.focusTask(taskId).catch((error: unknown) => {
    console.error('focusTask 失败', error);
  });
}

/** 打开任务(活跃直接聚焦,休眠以 --resume 复活)。 */
export function openTask(sessionId: string): void {
  // 乐观聚焦:活跃任务立即换源;休眠任务等 createTask 返回后再聚焦正式 id。
  const { runtimes } = useDesktopStore.getState();
  if (runtimes[sessionId]) {
    focusTask(sessionId);
    return;
  }
  void window.mojocode
    .openTask(sessionId)
    .then((taskId) => {
      useDesktopStore.getState().setFocused(taskId);
      useTimelineStore.getState().setFocused(taskId);
    })
    .catch((error: unknown) => {
      console.error('openTask 失败', error);
    });
}

/** 新建任务(在指定 root;缺省当前聚焦任务的 root)。 */
export function newTask(root?: string): void {
  const state = useDesktopStore.getState();
  const targetRoot = root ?? state.snapshot?.root;
  if (!targetRoot) return;
  // running 守卫(P3 单任务语义:新建会挤掉当前任务;P8 并行后移除)。
  if (state.snapshot?.agent.isRunning) return;
  void window.mojocode
    .createTask({ root: targetRoot })
    .then((taskId) => {
      useDesktopStore.getState().setFocused(taskId);
      useTimelineStore.getState().setFocused(taskId);
    })
    .catch((error: unknown) => {
      console.error('createTask 失败', error);
    });
}

/** 兼容旧名(⌘N / CollapsedOverlay / 空态按钮的调用点)。 */
export const newSession = newTask;
