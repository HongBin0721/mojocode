/**
 * 桥的 renderer 侧:订阅下行通道 → 写两个 store(会话状态 + 时间线)。
 *
 * 挂载顺序必须是「先 on、后 subscribe」:main 在 subscribe 的 handler 里就
 * 开始推送,晚了会漏首帧。renderer 重载/HMR 后重新走这里,main 侧幂等。
 */

import { deserializeEvent } from '@core/protocol';
import { useDesktopStore } from '../state/desktopStore.js';
import { useTimelineStore } from '../state/timelineStore.js';
import { makeTimelineCtx } from '../state/timelineCtx.js';
import { useReviewStore } from '../state/reviewStore.js';

export function initBridge(): () => void {
  const desktop = useDesktopStore;
  const timeline = useTimelineStore;
  const api = window.mojocode;
  const ctx = makeTimelineCtx(() => desktop.getState().snapshot);

  // 工作区切换(main 重启 sidecar 后强推快照)要把 Review 缓存清干净——
  // fileDiffs 按相对路径存,新 root 下的同名文件会命中旧 diff。
  let lastRoot: string | undefined;

  const offs = [
    api.on('state', (snapshot) => {
      if (lastRoot !== undefined && snapshot.root !== lastRoot) useReviewStore.getState().reset();
      lastRoot = snapshot.root;
      desktop.getState().applySnapshot(snapshot);
    }),
    api.on('connection', (connection) => desktop.getState().applyConnection(connection)),
    api.on('permission', (permission) => desktop.getState().applyPermission(permission)),
    api.on('sessions', (sessions) => desktop.getState().applySessions(sessions)),
    api.on('replay', (items) => timeline.getState().setItems(items)),
    api.on('event', (list) => {
      const { applyEvent } = timeline.getState();
      for (const wire of list) {
        const event = deserializeEvent(wire);
        // 决策已定(allow/deny):关掉审批卡。事件流的其余部分照常进 reducer。
        if (event.type === 'permission-resolved') {
          desktop.getState().applyPermission(undefined);
          continue;
        }
        applyEvent(event, ctx);
        // 一轮结束(正常/中断):agent 可能刚改过文件,Review 面板趁机刷新。
        if (event.type === 'turn-end' || event.type === 'aborted') {
          const review = useReviewStore.getState();
          if (review.visible) void review.refresh();
        }
      }
    }),
  ];

  void api
    .subscribe()
    .then(({ state, replayItems, connection }) => {
      lastRoot = state.root;
      desktop.getState().applySnapshot(state);
      desktop.getState().applyConnection(connection);
      timeline.getState().setItems(replayItems);
    })
    .catch((error: unknown) => {
      desktop.getState().applyConnection('lost');
      console.error('bridge subscribe 失败', error);
    });

  return () => {
    for (const off of offs) off();
  };
}
