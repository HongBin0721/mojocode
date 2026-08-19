/**
 * IPC 通道契约:下行推送通道的形状锁。
 *
 * preload 的 on() 以 pushChannelOf(逻辑名) 映射物理通道,曾因漏映射订阅到
 * 永无流量的通道,导致事件/状态/权限推送全部静默丢失(首屏靠 subscribe
 * 返回值正常,之后一发消息就「没反应」)。PUSH_CHANNELS 是运行时常量,
 * PushChannel 类型由它派生——新增通道只改一处,这里锁映射与去重。
 */

import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, PUSH_CHANNELS, pushChannelOf } from '../src/shared/ipc.js';

describe('IPC 通道契约', () => {
  it('每个下行逻辑名都有物理通道,值互不重复且带 bridge: 前缀', () => {
    const values = PUSH_CHANNELS.map((key) => IPC_CHANNELS[key]);
    expect(new Set(values).size).toBe(PUSH_CHANNELS.length);
    for (const value of values) {
      expect(value).toMatch(/^bridge:/);
    }
  });

  it('pushChannelOf:逻辑名映射到 IPC_CHANNELS 的对应值,未知名 throw', () => {
    for (const key of PUSH_CHANNELS) {
      expect(pushChannelOf(key)).toBe(IPC_CHANNELS[key]);
    }
    // 上行通道名不是下行逻辑名——订阅它必须炸而不是静默订空。
    expect(() => pushChannelOf('rpc' as never)).toThrow('未知下行通道');
    expect(() => pushChannelOf('bridge:event' as never)).toThrow('未知下行通道');
  });

  it('上行通道与下行通道不冲突', () => {
    const uplink = [
      IPC_CHANNELS.subscribe,
      IPC_CHANNELS.rpc,
      IPC_CHANNELS.pickDirectory,
      IPC_CHANNELS.taskCreate,
      IPC_CHANNELS.taskOpen,
      IPC_CHANNELS.taskClose,
      IPC_CHANNELS.taskFocus,
    ];
    expect(new Set(uplink).size).toBe(uplink.length);
    const downlink = PUSH_CHANNELS.map((key) => IPC_CHANNELS[key]);
    for (const channel of uplink) {
      expect(downlink).not.toContain(channel);
    }
  });
});
