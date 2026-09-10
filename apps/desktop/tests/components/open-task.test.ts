// @vitest-environment jsdom
/**
 * openTask 动作:快路径的判据与复活期的焦点纪律。
 *
 * 两条都是踩过的坑:残留 runtime 桶让快路径走进「main 侧无事发生」的死角,
 * 复活失败的退回则可能把已经点去别处的用户拽回来。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openTask } from '../../src/renderer/state/actions.js';
import { useDesktopStore } from '../../src/renderer/state/desktopStore.js';
import { useTimelineStore } from '../../src/renderer/state/timelineStore.js';
import type { TaskSummary } from '../../src/shared/ipc.js';

const task = (over: Partial<TaskSummary>): TaskSummary => ({
  id: 'id',
  root: '/w',
  provider: 'kimi',
  model: 'm',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  title: '任务',
  messageCount: 2,
  status: 'dormant',
  isRunning: false,
  unseen: false,
  ...over,
});

let openTaskRpc: ReturnType<typeof vi.fn>;
let focusTaskRpc: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openTaskRpc = vi.fn().mockResolvedValue('s-2');
  focusTaskRpc = vi.fn().mockResolvedValue(undefined);
  // 桥 API 经 globalThis 取值(见 utils/host.ts),不是 window.mojocode。
  (globalThis as { mojocode?: unknown }).mojocode = {
    openTask: openTaskRpc,
    focusTask: focusTaskRpc,
  };
  useDesktopStore.setState({ tasks: [], runtimes: {}, focusedTaskId: undefined });
  useTimelineStore.setState({ byTask: {}, focusedTaskId: undefined });
});

describe('openTask', () => {
  it('残留 runtime 桶 + 行已 dormant:走复活而不是快路径', async () => {
    // 空闲回收关掉了 s-2 的 sidecar(行还在,状态 dormant),但 renderer 的
    // runtime 桶不随之清理——照桶走 focusTask 的话 main 侧 `if (!task) return`
    // 静默无事,既不复活也不推回放,而桶里的 connection 还是 connected。
    useDesktopStore.setState({
      tasks: [task({ id: 's-2', status: 'dormant' })],
      runtimes: { 's-2': { connection: 'connected', snapshot: undefined, unread: false } },
      focusedTaskId: 's-1',
    });

    openTask('s-2');
    expect(focusTaskRpc).not.toHaveBeenCalled();
    expect(openTaskRpc).toHaveBeenCalledWith('s-2');
    // 复活期间镜像压回 connecting:main 的焦点还在 s-1 上,残桶若仍显示
    // connected,Composer 就会解禁并把消息投进上一个会话。
    expect(useDesktopStore.getState().connection).toBe('connecting');
    expect(useDesktopStore.getState().focusedTaskId).toBe('s-2');
  });

  it('行状态 connected 且有 runtime:走快路径 focusTask', () => {
    useDesktopStore.setState({
      tasks: [task({ id: 's-2', status: 'connected' })],
      runtimes: { 's-2': { connection: 'connected', snapshot: undefined, unread: false } },
      focusedTaskId: 's-1',
    });

    openTask('s-2');
    expect(focusTaskRpc).toHaveBeenCalledWith('s-2');
    expect(openTaskRpc).not.toHaveBeenCalled();
  });

  it('复活失败:用户已点去别处时不把焦点拽回来', async () => {
    let reject!: (error: Error) => void;
    openTaskRpc.mockReturnValue(
      new Promise((_resolve, rejectFn) => {
        reject = rejectFn;
      }),
    );
    useDesktopStore.setState({
      tasks: [task({ id: 's-2' }), task({ id: 's-3', status: 'connected' })],
      runtimes: { 's-1': { connection: 'connected', snapshot: undefined, unread: false } },
      focusedTaskId: 's-1',
    });

    openTask('s-2');
    expect(useDesktopStore.getState().focusedTaskId).toBe('s-2');
    // 复活要几秒,期间用户点去了 s-3。
    useDesktopStore.getState().setFocused('s-3');
    useTimelineStore.getState().setFocused('s-3');
    reject(new Error('活跃任务已满且都在运行中'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useDesktopStore.getState().focusedTaskId).toBe('s-3');
  });

  it('复活失败且用户仍停在该任务:退回原焦点', async () => {
    openTaskRpc.mockRejectedValue(new Error('spawn 失败'));
    useDesktopStore.setState({
      tasks: [task({ id: 's-2' })],
      runtimes: { 's-1': { connection: 'connected', snapshot: undefined, unread: false } },
      focusedTaskId: 's-1',
    });

    openTask('s-2');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useDesktopStore.getState().focusedTaskId).toBe('s-1');
  });
});
