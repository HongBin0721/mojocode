// @vitest-environment jsdom
/**
 * noticeStore(toast)与 invoke 层错误出口的行为锁:容量上限丢最旧、自动
 * 消失、rpcFire 失败路由到 notice(mock window.mojocode.rpc reject)。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pushNotice, useNoticeStore } from '../../src/renderer/state/noticeStore.js';
import { isUnknownMethodError, rpcCall, rpcFire } from '../../src/renderer/bridge/invoke.js';
import { setLocale } from '../../src/renderer/i18n/index.js';

setLocale('zh-CN');

const initial = useNoticeStore.getInitialState();

beforeEach(() => {
  vi.useFakeTimers();
  useNoticeStore.setState(initial, true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('noticeStore', () => {
  it('上限 3 条丢最旧,5s 自动消失', () => {
    for (const n of [1, 2, 3, 4]) pushNotice('info', `msg-${n}`);
    const messages = () => useNoticeStore.getState().notices.map((notice) => notice.message);
    expect(messages()).toEqual(['msg-2', 'msg-3', 'msg-4']);
    vi.advanceTimersByTime(5000);
    expect(messages()).toEqual([]);
  });

  it('dismiss 只关指定条', () => {
    pushNotice('info', 'a');
    pushNotice('error', 'b');
    const first = useNoticeStore.getState().notices[0]!;
    useNoticeStore.getState().dismiss(first.id);
    expect(useNoticeStore.getState().notices.map((notice) => notice.message)).toEqual(['b']);
  });
});

describe('invoke 层', () => {
  it('rpcFire 失败 → error notice,带 i18n 前缀与端点原始 message', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('boom from server'));
    (globalThis as { window: { mojocode: unknown } }).window.mojocode = { rpc };
    rpcFire({ kind: 'abort' }, { errorKey: 'notice.runFailed' });
    await vi.waitFor(() => {
      expect(useNoticeStore.getState().notices).toHaveLength(1);
    });
    const notice = useNoticeStore.getState().notices[0]!;
    expect(notice.level).toBe('error');
    expect(notice.message).toContain('发送消息失败');
    expect(notice.message).toContain('boom from server');
    // 未提供 taskId 时保持单参调用(原样转发,不追加显式 undefined)。
    expect(rpc).toHaveBeenCalledWith({ kind: 'abort' });
  });

  it('rpcCall 惰性取桥 API 并原样上抛(调用方自己消化)', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('unknown method: workspaceStatus'));
    (globalThis as { window: { mojocode: unknown } }).window.mojocode = { rpc };
    const error = await rpcCall({ kind: 'workspaceStatus' }).catch((e: unknown) => e);
    expect(isUnknownMethodError(error)).toBe(true);
    expect(useNoticeStore.getState().notices).toHaveLength(0); // rpcCall 不进 notice
  });

  it('isUnknownMethodError 认 Electron invoke 前缀(includes 而非全等)', () => {
    const wrapped = new Error(
      "Error invoking remote method 'bridge:rpc': Error: unknown method: fileDiff",
    );
    expect(isUnknownMethodError(wrapped)).toBe(true);
    expect(isUnknownMethodError(new Error('boom'))).toBe(false);
    expect(isUnknownMethodError('unknown method')).toBe(false);
  });
});
