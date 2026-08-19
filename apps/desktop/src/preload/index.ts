/**
 * preload:经 contextBridge 暴露类型化的桥 API(`window.mojocode`)。
 * sandbox 环境,只能用 contextBridge + ipcRenderer 两个 Electron API。
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC_CHANNELS, pushChannelOf, type PushChannel, type RpcRequest } from '../shared/ipc.js';
import type { MojocodeDesktopApi } from '../shared/api.js';

const api: MojocodeDesktopApi = {
  subscribe: () => ipcRenderer.invoke(IPC_CHANNELS.subscribe),
  rpc: (request: RpcRequest, taskId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.rpc, request, taskId),
  // sandbox 下 process 是裁剪版,platform 字段仍在——renderer 据此做 mac 让位。
  platform: process.platform,
  pickDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.pickDirectory),
  createTask: (opts) => ipcRenderer.invoke(IPC_CHANNELS.taskCreate, opts),
  openTask: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.taskOpen, sessionId),
  closeTask: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.taskClose, taskId),
  focusTask: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.taskFocus, taskId),
  revealPath: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.revealPath, path),
  openPath: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.openPath, path),
  // 同步 API:webUtils 在 preload 侧直接可用,不必绕 invoke。
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  on: (channel, listener) => {
    // 逻辑名 → 物理通道的映射在 shared/ipc.ts 的 pushChannelOf(preload 顶层
    // import electron 进不了 node 测试,映射逻辑放 shared 才测得到)。
    const physical = pushChannelOf(channel as PushChannel);
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
