/**
 * 时间线 store:reducer 的 zustand 包装,多任务分片(byTask)。顶层的
 * TimelineState 字段是**聚焦任务的镜像**——组件继续用平铺选择器,不感知
 * 分桶。桥事件是命令式外部源,回调里 `applyEvent` 直写;replay 通道到达时
 * 整桶替换(见 setItems 的重置语义)。
 *
 * 内存纪律:只保「本次运行聚焦过」的任务,LRU 上限 3(聚焦槽豁免)——
 * 后台任务在 main 侧被抑制转发,这里的桶只是聚焦切换的缓存。
 */

import { create } from 'zustand';
import type { AgentEvent } from '@core/events';
import type { TimelineItem } from '@core/types';
import {
  initialTimelineState,
  reduceTimeline,
  type TimelineCtx,
  type TimelineState,
} from './timelineReducer.js';

const MAX_TASK_BUCKETS = 3;

export interface TimelineStore extends TimelineState {
  byTask: Record<string, TimelineState>;
  focusedTaskId: string | undefined;

  applyEvent(taskId: string, event: AgentEvent, ctx: TimelineCtx): void;
  /** replay 到达 / 聚焦复活:整桶替换 items,清空活动区。 */
  setItems(taskId: string, items: TimelineItem[]): void;
  /** 聚焦切换:换源顶层镜像(桶不存在时给空时间线,等 replay 到达)。 */
  setFocused(taskId: string | undefined): void;
}

/** LRU 淘汰:桶数超限时丢「非聚焦」里最早建的(Record 保持插入序)。 */
function evictIfNeeded(
  byTask: Record<string, TimelineState>,
  focusedTaskId: string | undefined,
): Record<string, TimelineState> {
  const keys = Object.keys(byTask);
  if (keys.length <= MAX_TASK_BUCKETS) return byTask;
  const victim = keys.find((key) => key !== focusedTaskId);
  if (!victim) return byTask;
  const next = { ...byTask };
  delete next[victim];
  return next;
}

export const useTimelineStore = create<TimelineStore>((set) => ({
  ...initialTimelineState(undefined),
  byTask: {},
  focusedTaskId: undefined,

  applyEvent: (taskId, event, ctx) =>
    set((state) => {
      const prev = state.byTask[taskId] ?? initialTimelineState(undefined);
      const next = reduceTimeline(prev, event, ctx);
      const byTask = evictIfNeeded({ ...state.byTask, [taskId]: next }, state.focusedTaskId);
      return taskId === state.focusedTaskId ? { ...next, byTask } : { byTask };
    }),

  setItems: (taskId, items) =>
    set((state) => {
      // 活动区一并清零:回放对应的是已完成的历史,进行中的流式内容
      // 不恢复(与 TUI `--attach` 语义一致;P8 的当前轮缓冲重放会补齐)。
      const next: TimelineState = { ...initialTimelineState(undefined), items };
      const byTask = evictIfNeeded({ ...state.byTask, [taskId]: next }, state.focusedTaskId);
      return taskId === state.focusedTaskId ? { ...next, byTask } : { byTask };
    }),

  setFocused: (taskId) =>
    set((state) => {
      const mirror = (taskId ? state.byTask[taskId] : undefined) ?? initialTimelineState(undefined);
      return { ...mirror, focusedTaskId: taskId, byTask: state.byTask };
    }),
}));
