/**
 * 桥的 renderer 侧:订阅下行通道(TaskScoped 信封)→ 按 taskId 分桶写两个
 * store(会话状态 + 时间线)。
 *
 * 挂载顺序必须是「先 on、后 subscribe」:main 在 subscribe 的 handler 里就
 * 开始推送,晚了会漏首帧。renderer 重载/HMR 后重新走这里,main 侧幂等。
 */

import { deserializeEvent } from '@core/protocol';
import { bridgeApi } from '../utils/host.js';
import { useDesktopStore } from '../state/desktopStore.js';
import { useTimelineStore } from '../state/timelineStore.js';
import { makeTimelineCtx } from '../state/timelineCtx.js';
import { useReviewStore } from '../state/reviewStore.js';
import { usePanelStore } from '../state/panelStore.js';
import type { TimelineCtx } from '../state/timelineReducer.js';

export function initBridge(): () => void {
  const desktop = useDesktopStore;
  const timeline = useTimelineStore;
  const api = bridgeApi();

  // reducer 的 ctx 按任务分份:每个任务的事件要对照**它自己**的快照。
  const ctxByTask = new Map<string, TimelineCtx>();
  const ctxOf = (taskId: string): TimelineCtx => {
    let ctx = ctxByTask.get(taskId);
    if (!ctx) {
      ctx = makeTimelineCtx(() => desktop.getState().runtimes[taskId]?.snapshot);
      ctxByTask.set(taskId, ctx);
    }
    return ctx;
  };

  // effect: 聚焦任务的 root 变化(切换到另一个项目的任务)要把 Review 缓存
  // 清干净——fileDiffs 按相对路径存,新 root 下的同名文件会命中旧 diff。
  // (「effect:」标记 = 寄生在传输层的业务编排,候选外提;现无测试守护,
  // 保持原位。)
  let lastFocusedRoot: string | undefined;
  const maybeResetReview = (): void => {
    const state = desktop.getState();
    const root = state.snapshot?.root;
    if (root === undefined) return;
    if (lastFocusedRoot !== undefined && root !== lastFocusedRoot) {
      useReviewStore.getState().reset();
    }
    lastFocusedRoot = root;
  };

  const offs = [
    api.on('state', ({ taskId, data }) => {
      desktop.getState().applyState(taskId, data);
      maybeResetReview();
    }),
    api.on('connection', ({ taskId, data }) => desktop.getState().applyConnection(taskId, data)),
    api.on('permission', ({ taskId, data }) => desktop.getState().applyPermission(taskId, data)),
    api.on('tasks', (tasks) => desktop.getState().applyTasks(tasks)),
    api.on('replay', ({ taskId, data }) => timeline.getState().setItems(taskId, data)),
    api.on('event', ({ taskId, data }) => {
      const { applyEvent } = timeline.getState();
      for (const wire of data) {
        const event = deserializeEvent(wire);
        // effect: 决策已定(allow/deny)关掉审批卡。事件流的其余部分照常进 reducer。
        if (event.type === 'permission-resolved') {
          desktop.getState().applyPermission(taskId, undefined);
          continue;
        }
        // effect: 终端面板——bash 的流式输出与命令行注入(reducer 对该类型是 no-op)。
        if (event.type === 'tool-output-delta') {
          usePanelStore.getState().appendChunk(taskId, event.chunk);
          continue;
        }
        if (event.type === 'tool-start' && event.toolName === 'bash') {
          const command = (event.input as { command?: string } | undefined)?.command;
          if (command) usePanelStore.getState().appendCommand(taskId, command);
        }
        applyEvent(taskId, event, ctxOf(taskId));
        // effect: 一轮结束(正常/中断)时 agent 可能刚改过文件,Review 面板
        // 趁机刷新(只在事件来自聚焦任务时——面板显示的是聚焦任务的 root)。
        if (
          (event.type === 'turn-end' || event.type === 'aborted') &&
          taskId === desktop.getState().focusedTaskId
        ) {
          const review = useReviewStore.getState();
          if (review.visible) void review.refresh();
        }
      }
    }),
  ];

  void api
    .subscribe()
    .then(({ focusedTaskId, tasks, live }) => {
      desktop.getState().applyTasks(tasks);
      for (const entry of live) {
        desktop.getState().applyState(entry.taskId, entry.state);
        desktop.getState().applyConnection(entry.taskId, entry.connection);
        if (entry.permission) desktop.getState().applyPermission(entry.taskId, entry.permission);
        if (entry.replayItems) timeline.getState().setItems(entry.taskId, entry.replayItems);
      }
      desktop.getState().setFocused(focusedTaskId);
      timeline.getState().setFocused(focusedTaskId);
      maybeResetReview();
    })
    .catch((error: unknown) => {
      // 无任务可聚焦(启动中/首个 sidecar 失败):镜像保持 connecting,
      // 真正的失败由 main 的错误对话框兜底。
      console.error('bridge subscribe 失败', error);
    });

  return () => {
    for (const off of offs) off();
  };
}
