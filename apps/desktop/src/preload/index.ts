/**
 * preload:经 contextBridge 暴露类型化的桥 API(`window.mojocode`)。
 * sandbox 环境,只能用 contextBridge + ipcRenderer 两个 Electron API。
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type RpcRequest } from '../shared/ipc.js';
import type { MojocodeDesktopApi } from '../shared/api.js';

const api: MojocodeDesktopApi = {
  subscribe: () => ipcRenderer.invoke(IPC_CHANNELS.subscribe),
  rpc: (request: RpcRequest) => ipcRenderer.invoke(IPC_CHANNELS.rpc, request),
  on: (channel, listener) => {
    const wrapped = (_event: unknown, payload: unknown): void => {
      (listener as (payload: unknown) => void)(payload);
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('mojocode', api);
