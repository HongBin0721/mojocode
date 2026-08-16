/**
 * IPC 通道契约:下行推送通道的形状锁。
 *
 * preload 的 on() 以 IPC_CHANNELS[逻辑名] 映射物理通道,曾因漏映射订阅到
 * 永无流量的通道,导致事件/状态/权限推送全部静默丢失(首屏靠 subscribe
 * 返回值正常,之后一发消息就「没反应」)。这里锁死:PushChannel 全集每个
 * 键都有物理通道、值互不重复、前缀一致——任何一侧改动必须同步另一侧。
 */

import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, type PushChannel } from '../src/shared/ipc.js';

// 与 PushChannel 类型声明保持同步的运行时副本(类型不进测试运行时)。
const DOWNLINK: readonly PushChannel[] = [
  'state',
  'event',
  'replay',
  'connection',
  'permission',
  'sessions',
];

describe('IPC 通道契约', () => {
  it('每个下行逻辑名都有物理通道,值互不重复且带 bridge: 前缀', () => {
    const values = DOWNLINK.map((key) => IPC_CHANNELS[key]);
    expect(new Set(values).size).toBe(DOWNLINK.length);
    for (const value of values) {
      expect(value).toMatch(/^bridge:/);
    }
  });

  it('上行通道与下行通道不冲突', () => {
    const uplink = [IPC_CHANNELS.subscribe, IPC_CHANNELS.rpc];
    const downlink = DOWNLINK.map((key) => IPC_CHANNELS[key]);
    for (const channel of uplink) {
      expect(downlink).not.toContain(channel);
    }
  });
});
