/**
 * preload:经 contextBridge 暴露类型化的桥 API(`window.mojocode`)。
 * sandbox 环境,只能用 contextBridge + ipcRenderer 两个 Electron API。
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type PushChannel, type RpcRequest } from '../shared/ipc.js';
import type { MojocodeDesktopApi } from '../shared/api.js';

const api: MojocodeDesktopApi = {
  subscribe: () => ipcRenderer.invoke(IPC_CHANNELS.subscribe),
  rpc: (request: RpcRequest) => ipcRenderer.invoke(IPC_CHANNELS.rpc, request),
  // sandbox 下 process 是裁剪版,platform 字段仍在——renderer 据此做 mac 让位。
  platform: process.platform,
  on: (channel, listener) => {
    // 逻辑名 → 物理通道:main 侧 send 的是 IPC_CHANNELS 的值('bridge:event'
    // 等)。漏映射会订阅到永远没有流量的通道,下行推送全部静默丢失——
    // 首屏靠 subscribe 返回值仍正常,此后事件/状态/权限一概不回显(踩过的坑)。
    const physical = IPC_CHANNELS[channel as PushChannel];
    const wrapped = (_event: unknown, payload: unknown): void => {
      (listener as (payload: unknown) => void)(payload);
    };
    ipcRenderer.on(physical, wrapped);
    return () => {
      ipcRenderer.removeListener(physical, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('mojocode', api);
