/**
 * 时间线 store:reducer 的 zustand 包装。桥事件是命令式外部源,回调里
 * `applyEvent` 直写;replay 通道到达时整体替换(见 setItems 的重置语义)。
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

export interface TimelineStore extends TimelineState {
  applyEvent(event: AgentEvent, ctx: TimelineCtx): void;
  /** replay 到达 / 换会话:完整替换 items,清空活动区。 */
  setItems(items: TimelineItem[]): void;
}

export const useTimelineStore = create<TimelineStore>((set) => ({
  ...initialTimelineState(undefined),

  applyEvent: (event, ctx) =>
    set((state) => reduceTimeline(state, event, ctx)),

  setItems: (items) =>
    set({
      // 活动区一并清零:回放对应的是已完成的历史,进行中的流式内容
      // 不恢复(与 TUI `--attach` 语义一致)。
      ...initialTimelineState(undefined),
      items,
    }),
}));
