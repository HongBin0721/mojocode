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
import type { TimelineImage, TimelineItem } from '@core/types';
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
  /**
   * 提交时暂存的随消息图片(按任务)。turn-start 事件刻意不带图片字节
   * (总线广播 + 回放环缓冲不该扛 base64),而提交方的 renderer 手里就有
   * 原图——Composer 发 run 前存这里,turn-start 落地时缝到用户条目上。
   * 连 `text` 一起存:缝之前要核对是同一条消息,详见 applyEvent。
   */
  pendingImages: Record<string, { text: string; images: TimelineImage[] }>;

  stashPendingImages(taskId: string, text: string, images: TimelineImage[]): void;
  /** 提交失败/放弃:丢掉暂存,别让这份 base64 无主地留到窗口关闭。 */
  dropPendingImages(taskId: string): void;
  applyEvent(taskId: string, event: AgentEvent, ctx: TimelineCtx): void;
  /** replay 到达 / 聚焦复活:整桶替换 items,清空活动区。 */
  setItems(taskId: string, items: TimelineItem[]): void;
  /** 聚焦切换:换源顶层镜像(桶不存在时给空时间线,等 replay 到达)。 */
  setFocused(taskId: string | undefined): void;
}

/**
 * LRU 淘汰:桶数超限时丢「非聚焦」里最早建的(Record 保持插入序),**连同
 * 它的提交暂存图**——桶没了就再没有 turn-start 会来消费那份暂存,不清就
 * 挂到窗口关闭(单条最大 ~10MB base64)。两份分片状态一起进一起出,淘汰
 * 这件事因此只有一个知情者;判据只认真被淘汰的那个 id,按"不在 byTask 里"
 * 一刀切会误伤刚暂存、桶还没建起来的任务。
 */
function evictIfNeeded(
  byTask: Record<string, TimelineState>,
  pendingImages: TimelineStore['pendingImages'],
  focusedTaskId: string | undefined,
): { byTask: Record<string, TimelineState>; pendingImages: TimelineStore['pendingImages'] } {
  const keys = Object.keys(byTask);
  if (keys.length <= MAX_TASK_BUCKETS) return { byTask, pendingImages };
  const victim = keys.find((key) => key !== focusedTaskId);
  if (!victim) return { byTask, pendingImages };
  const nextTasks = { ...byTask };
  delete nextTasks[victim];
  if (!(victim in pendingImages)) return { byTask: nextTasks, pendingImages };
  const nextPending = { ...pendingImages };
  delete nextPending[victim];
  return { byTask: nextTasks, pendingImages: nextPending };
}

export const useTimelineStore = create<TimelineStore>((set) => ({
  ...initialTimelineState(undefined),
  byTask: {},
  focusedTaskId: undefined,
  pendingImages: {},

  stashPendingImages: (taskId, text, images) =>
    set((state) => ({ pendingImages: { ...state.pendingImages, [taskId]: { text, images } } })),

  dropPendingImages: (taskId) =>
    set((state) => {
      if (!(taskId in state.pendingImages)) return {};
      const pendingImages = { ...state.pendingImages };
      delete pendingImages[taskId];
      return { pendingImages };
    }),

  applyEvent: (taskId, event, ctx) =>
    set((state) => {
      const prev = state.byTask[taskId] ?? initialTimelineState(undefined);
      let next = reduceTimeline(prev, event, ctx);
      let pendingImages = state.pendingImages;
      // turn-start 消费该任务的暂存图。核对**三件事**才缝:是用户条目、
      // 张数与 imageCount 一致、条目文本正是提交时那条——只比张数不够,
      // 引导注入(inject)不发 turn-start,它留下的暂存会活到下一次
      // turn-start,那时张数可能凑巧相同(将来若给 run 加服务端 @ 展开就
      // 更可能),文本比对能保证宁可不缝也不错缝。无论缝没缝都清掉。
      if (event.type === 'turn-start' && taskId in pendingImages) {
        const stash = pendingImages[taskId];
        pendingImages = { ...pendingImages };
        delete pendingImages[taskId];
        const last = next.items[next.items.length - 1];
        const shown = event.display ?? event.userText;
        if (
          stash &&
          stash.images.length === event.imageCount &&
          stash.text === shown &&
          last?.kind === 'user'
        ) {
          next = {
            ...next,
            items: [...next.items.slice(0, -1), { ...last, images: stash.images }],
          };
        }
      }
      const evicted = evictIfNeeded(
        { ...state.byTask, [taskId]: next },
        pendingImages,
        state.focusedTaskId,
      );
      return taskId === state.focusedTaskId ? { ...next, ...evicted } : evicted;
    }),

  setItems: (taskId, items) =>
    set((state) => {
      // 活动区一并清零:回放对应的是已完成的历史,进行中的流式内容
      // 不恢复(与 TUI `--attach` 语义一致;P8 的当前轮缓冲重放会补齐)。
      const next: TimelineState = { ...initialTimelineState(undefined), items };
      const evicted = evictIfNeeded(
        { ...state.byTask, [taskId]: next },
        state.pendingImages,
        state.focusedTaskId,
      );
      return taskId === state.focusedTaskId ? { ...next, ...evicted } : evicted;
    }),

  setFocused: (taskId) =>
    set((state) => {
      const mirror = (taskId ? state.byTask[taskId] : undefined) ?? initialTimelineState(undefined);
      return { ...mirror, focusedTaskId: taskId, byTask: state.byTask };
    }),
}));
