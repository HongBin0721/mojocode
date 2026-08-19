// @vitest-environment jsdom
/**
 * renderer/bridge/client.ts 的分发测试:下行通道(TaskScoped 信封)→ 按
 * taskId 分桶写 store,以及寄生在事件循环里的三段编排(permission-resolved
 * 关审批卡 / tool-output-delta 转终端面板 / turn-end 触发 review 刷新)与
 * 聚焦 root 变化清 review 缓存。四个 zustand 单例 beforeEach 复位,review
 * 的 refresh/reset 用 vi.fn() 打桩避免真发 RPC。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeEvent } from '@core/protocol';
import type { AgentEvent } from '@core/events';
import type { StateSnapshot } from '@core/protocol';
import { initBridge } from '../../src/renderer/bridge/client.js';
import { useDesktopStore } from '../../src/renderer/state/desktopStore.js';
import { useTimelineStore } from '../../src/renderer/state/timelineStore.js';
import { usePanelStore } from '../../src/renderer/state/panelStore.js';
import { useReviewStore } from '../../src/renderer/state/reviewStore.js';

type Listener = (payload: unknown) => void;

interface FakeApi {
  listeners: Map<string, Listener>;
  unsubs: Map<string, ReturnType<typeof vi.fn>>;
  resolveSubscribe: (value: unknown) => void;
  emit(channel: string, payload: unknown): void;
  emitEvents(taskId: string, events: AgentEvent[]): void;
}

function makeSnapshot(root: string): StateSnapshot {
  return { root } as unknown as StateSnapshot;
}

function installFakeApi(): FakeApi {
  const listeners = new Map<string, Listener>();
  const unsubs = new Map<string, ReturnType<typeof vi.fn>>();
  let resolveSubscribe: (value: unknown) => void = () => {};
  const subscribePromise = new Promise((resolve) => {
    resolveSubscribe = resolve;
  });
  const api = {
    on: (channel: string, listener: Listener) => {
      listeners.set(channel, listener);
      const off = vi.fn();
      unsubs.set(channel, off);
      return off;
    },
    subscribe: () => subscribePromise,
  };
  (globalThis as { window: { mojocode: unknown } }).window.mojocode = api;
  return {
    listeners,
    unsubs,
    resolveSubscribe,
    emit: (channel, payload) => listeners.get(channel)!(payload),
    emitEvents: (taskId, events) =>
      listeners.get('event')!({ taskId, data: events.map(serializeEvent) }),
  };
}

const initialDesktop = useDesktopStore.getInitialState();
const initialTimeline = useTimelineStore.getInitialState();
const initialPanel = usePanelStore.getInitialState();
const initialReview = useReviewStore.getInitialState();

let dispose: (() => void) | undefined;
let reviewRefresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
let reviewReset: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  useDesktopStore.setState(initialDesktop, true);
  useTimelineStore.setState(initialTimeline, true);
  usePanelStore.setState(initialPanel, true);
  reviewRefresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  reviewReset = vi.fn<() => void>();
  useReviewStore.setState(
    { ...initialReview, visible: true, refresh: reviewRefresh, reset: reviewReset },
    true,
  );
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

describe('initBridge', () => {
  it('subscribe 结果分发:tasks/state/connection/permission/replay 各就各位,聚焦镜像换源', async () => {
    const api = installFakeApi();
    dispose = initBridge();
    const permission = { id: 'p1' };
    api.resolveSubscribe({
      focusedTaskId: 't1',
      tasks: [{ id: 't1' }],
      live: [
        {
          taskId: 't1',
          state: makeSnapshot('/ws/a'),
          connection: 'connected',
          permission,
          replayItems: [{ key: 'replay-banner', kind: 'banner' }],
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();
    const desktop = useDesktopStore.getState();
    expect(desktop.tasks).toEqual([{ id: 't1' }]);
    expect(desktop.focusedTaskId).toBe('t1');
    expect(desktop.connection).toBe('connected');
    expect(desktop.permission).toEqual(permission);
    const timeline = useTimelineStore.getState();
    expect(timeline.focusedTaskId).toBe('t1');
    expect(timeline.items.map((item) => item.key)).toEqual(['replay-banner']);
  });

  it('事件按 taskId 进各自的桶,聚焦桶镜像到顶层', () => {
    const api = installFakeApi();
    dispose = initBridge();
    useDesktopStore.getState().setFocused('t1');
    useTimelineStore.getState().setFocused('t1');
    api.emitEvents('t1', [{ type: 'turn-start', userText: 'hi' } as AgentEvent]);
    api.emitEvents('t2', [{ type: 'turn-start', userText: 'hi' } as AgentEvent]);
    const { byTask } = useTimelineStore.getState();
    expect(Object.keys(byTask).sort()).toEqual(['t1', 't2']);
  });

  it('permission-resolved → 清对应任务的审批卡,不进 reducer', () => {
    const api = installFakeApi();
    dispose = initBridge();
    useDesktopStore.getState().applyPermission('t1', { id: 'p1' } as never);
    api.emitEvents('t1', [
      { type: 'permission-resolved', id: 'p1', decision: { type: 'allow' } } as AgentEvent,
    ]);
    expect(useDesktopStore.getState().runtimes['t1']?.permission).toBeUndefined();
    expect(useTimelineStore.getState().byTask['t1']).toBeUndefined();
  });

  it('tool-output-delta → panelStore.appendChunk,不进 reducer;bash tool-start 注入命令行', () => {
    const api = installFakeApi();
    dispose = initBridge();
    api.emitEvents('t1', [
      { type: 'tool-start', callId: 'c1', toolName: 'bash', input: { command: 'ls' } } as AgentEvent,
      { type: 'tool-start', callId: 'c2', toolName: 'read', input: {} } as AgentEvent,
      { type: 'tool-output-delta', callId: 'c1', chunk: 'out-1' } as AgentEvent,
    ]);
    const terminal = usePanelStore.getState().terminals['t1'];
    expect(terminal?.lines).toEqual([{ text: '$ ls', kind: 'cmd' }]);
    expect(terminal?.partial).toBe('out-1');
    // tool-start 进 reducer(t1 桶已建),tool-output-delta 不进(reducer 对它是 no-op)
    expect(useTimelineStore.getState().byTask['t1']).toBeDefined();
  });

  it('turn-end/aborted:聚焦任务且面板可见才触发 review.refresh', () => {
    const api = installFakeApi();
    dispose = initBridge();
    useDesktopStore.getState().setFocused('t1');
    const turnEnd = {
      type: 'turn-end',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: 'stop',
    } as unknown as AgentEvent;
    api.emitEvents('t2', [turnEnd]); // 非聚焦任务:不刷
    expect(reviewRefresh).not.toHaveBeenCalled();
    api.emitEvents('t1', [turnEnd]); // 聚焦 + visible:刷
    expect(reviewRefresh).toHaveBeenCalledTimes(1);
    useReviewStore.setState({ visible: false });
    api.emitEvents('t1', [{ type: 'aborted' } as AgentEvent]); // 面板隐藏:不刷
    expect(reviewRefresh).toHaveBeenCalledTimes(1);
  });

  it('聚焦 root 变化 → review.reset;首帧与同 root 不触发', () => {
    const api = installFakeApi();
    dispose = initBridge();
    useDesktopStore.getState().setFocused('t1');
    api.emit('state', { taskId: 't1', data: makeSnapshot('/ws/a') });
    expect(reviewReset).not.toHaveBeenCalled(); // 首帧只记录
    api.emit('state', { taskId: 't1', data: makeSnapshot('/ws/a') });
    expect(reviewReset).not.toHaveBeenCalled(); // 同 root
    api.emit('state', { taskId: 't1', data: makeSnapshot('/ws/b') });
    expect(reviewReset).toHaveBeenCalledTimes(1); // 换项目
  });

  it('dispose 调用每个通道的退订函数', () => {
    const api = installFakeApi();
    const off = initBridge();
    off();
    dispose = undefined;
    for (const [channel, unsub] of api.unsubs) {
      expect(unsub, channel).toHaveBeenCalledTimes(1);
    }
    expect(api.unsubs.size).toBe(6);
  });
});
