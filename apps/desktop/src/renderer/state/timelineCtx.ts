/**
 * reducer 的 ctx:从桌面状态快照(StateSnapshot)读取事件分支需要的
 * 会话事实。快照由 server 的 state 帧驱动,事件与快照的先后差异与 TUI
 * 读镜像信号时的粒度相同——不影响语义。
 */

import type { StateSnapshot } from '@core/protocol';
import type { TimelineCtx } from './timelineReducer.js';

export function makeTimelineCtx(snapshotOf: () => StateSnapshot | undefined): TimelineCtx {
  const snap = (): StateSnapshot | undefined => snapshotOf();
  return {
    getModel: () => snap()?.provider.model ?? '',
    isAgentRunning: () => snap()?.agent.isRunning ?? false,
  };
}
