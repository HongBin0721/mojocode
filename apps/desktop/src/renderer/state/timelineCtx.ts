/**
 * reducer 的 ctx:从桌面状态快照(StateSnapshot)读取事件分支需要的
 * 会话事实。快照由 server 的 state 帧驱动,事件与快照的先后差异与 TUI
 * 读镜像信号时的粒度相同——不影响语义。
 *
 * onPermissionRequest / onPermissionChange 传 noop:GUI 的审批卡由
 * bridge:permission 通道权威驱动(比事件流多一条"renderer 重载后重发"),
 * 权限镜像则由下一个 state 帧覆盖(pushState 在每个事件后重算)。
 */

import type { StateSnapshot } from '@core/protocol';
import type { TimelineCtx } from './timelineReducer.js';

export function makeTimelineCtx(snapshotOf: () => StateSnapshot | undefined): TimelineCtx {
  const snap = (): StateSnapshot | undefined => snapshotOf();
  return {
    getModel: () => snap()?.provider.model ?? '',
    getConfig: () => {
      const config = snap()?.config;
      return { plan: config?.plan ?? false, goalMaxTurns: config?.goalMaxTurns ?? 0 };
    },
    isGoalBusy: () => snap()?.goal.busy ?? false,
    isGoalActive: () => snap()?.goal.active ?? false,
    isAgentRunning: () => snap()?.agent.isRunning ?? false,
    onPermissionRequest: () => {},
    onPermissionChange: () => {},
  };
}
