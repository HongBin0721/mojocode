/**
 * 会话级全局状态(zustand):连接态、server 推送的状态快照、待决审批。
 * 时间线(事件 reducer 的产物)在独立的 timelineStore;两个 store 都由
 * bridge/client.ts 从桥事件驱动。
 */

import { create } from 'zustand';
import type { PermissionRequest } from '@core/events';
import type { StateSnapshot } from '@core/protocol';
import type { ConnectionState, SessionMetaSummary } from '../../shared/ipc.js';

export interface DesktopStore {
  connection: ConnectionState;
  snapshot: StateSnapshot | undefined;
  permission: PermissionRequest | undefined;
  /** undefined = 尚未收到(server 过旧,侧栏降级提示);[] = 无会话。 */
  sessions: SessionMetaSummary[] | undefined;
  /** 模型菜单的外部触发计数(/models 命令 → Composer 工具栏的菜单打开),每次 +1。 */
  modelMenuRequest: number;

  applySnapshot(snapshot: StateSnapshot): void;
  applyConnection(connection: ConnectionState): void;
  applyPermission(permission: PermissionRequest | undefined): void;
  applySessions(sessions: SessionMetaSummary[] | undefined): void;
  requestModelsMenu(): void;
}

export const useDesktopStore = create<DesktopStore>((set) => ({
  connection: 'connecting',
  snapshot: undefined,
  permission: undefined,
  sessions: undefined,
  modelMenuRequest: 0,

  applySnapshot: (snapshot) => set({ snapshot }),
  applyConnection: (connection) => set({ connection }),
  applyPermission: (permission) => set({ permission }),
  applySessions: (sessions) => set({ sessions }),
  requestModelsMenu: () => set((state) => ({ modelMenuRequest: state.modelMenuRequest + 1 })),
}));
