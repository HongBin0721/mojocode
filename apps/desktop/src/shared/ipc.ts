/**
 * main ↔ renderer 的 IPC 契约。两端共用,不 import 任何 Node / Electron API
 * (preload 在 sandbox 下运行,shared 里的代码要能进任何一端)。
 *
 * 下行(main → renderer,webContents.send):
 *  - `bridge:state`     StateSnapshot 整份(main 侧微任务合并 + snapshotKey 去重)
 *  - `bridge:event`     AgentEvent[](微任务内合并成批,serializeEvent 后的形态)
 *  - `bridge:replay`    TimelineItem[](订阅时与换会话后整体重推)
 *  - `bridge:connection` ConnectionState
 *  - `bridge:permission` PermissionRequest(待决审批,重载后 renderer 侧靠重订阅恢复)
 *
 * 上行(renderer → main,ipcRenderer.invoke):
 *  - `bridge:subscribe` 幂等:返回当前快照 + 回放条目,此后开始推送
 *  - `bridge:rpc`       RpcRequest 判别联合,main 侧白名单方法表分发
 */

import type { serializeEvent, StateSnapshot } from '@core/protocol';
import type { AgentEvent, PermissionDecision, PermissionRequest } from '@core/events';
import type { Permissions, ReasoningEffort } from '@core/schema';
import type { ImageAttachment } from '@core/attachments';
import type { TimelineItem } from '@core/types';

/**
 * 会话列表条目。形状复制自根仓库 src/session/store.ts 的 SessionMeta(wire
 * 契约都是 JSON 原生类型;store.ts 带 node:fs,进不了两端共用的 shared)。
 */
export interface SessionMetaSummary {
  id: string;
  root: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  messageCount: number;
}

/**
 * 工作区 pending 变更(Review 面板数据源)。形状复制自根仓库
 * src/agent/workspace.ts 的 WorkspaceStatus/FileDiff(server 侧模块带
 * execa,同 SessionMetaSummary 的处理)。
 */
export interface WorkspaceFileEntrySummary {
  path: string;
  change: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  staged: boolean;
  renameFrom?: string;
  additions?: number;
  deletions?: number;
}

export interface WorkspaceStatusSummary {
  ok: boolean;
  branch?: string;
  entries: WorkspaceFileEntrySummary[];
  additions: number;
  deletions: number;
  truncated: boolean;
}

export type FileDiffFailure = 'no-repo' | 'not-found' | 'binary' | 'invalid-path' | 'git-error';

export interface FileDiffSummary {
  ok: boolean;
  reason?: FileDiffFailure;
  path: string;
  diff?: string;
  truncated: boolean;
}

/** 模型菜单数据源。形状复制自根仓库 src/model/registry.ts 的 ProviderModels。 */
export interface ProviderModelsSummary {
  providerId: string;
  label: string;
  contextWindows?: Record<string, number>;
  models: Array<{ id: string; ownedBy?: string }>;
  error?: string;
}

export const IPC_CHANNELS = {
  subscribe: 'bridge:subscribe',
  rpc: 'bridge:rpc',
  state: 'bridge:state',
  event: 'bridge:event',
  replay: 'bridge:replay',
  connection: 'bridge:connection',
  permission: 'bridge:permission',
  sessions: 'bridge:sessions',
  /* 下面两个是 main 本地能力(Electron dialog / sidecar 重启),不进 bridge
   * 的 RPC 白名单——bridge 保持 electron-free 可测。 */
  pickDirectory: 'desktop:pick-directory',
  switchWorkspace: 'desktop:switch-workspace',
} as const;

export type ConnectionState = 'connecting' | 'connected' | 'lost';

export type RpcRequest =
  | { kind: 'run'; text: string; options?: { display?: string; images?: ImageAttachment[] } }
  | { kind: 'inject'; text: string; images?: ImageAttachment[] }
  | { kind: 'abort' }
  | { kind: 'compact' }
  | { kind: 'newSession' }
  | { kind: 'resumeSession'; idOrPrefix: string }
  | { kind: 'forkSession' }
  | { kind: 'switch'; change: { provider?: string; model?: string; apiKey?: string } }
  | { kind: 'setPermissions'; permissions: Permissions }
  | { kind: 'setPlan'; active: boolean }
  | { kind: 'setReasoningEffort'; level: ReasoningEffort }
  | { kind: 'listSessions' }
  | { kind: 'listProviderModels' }
  | { kind: 'runSkill'; name: string; args: string; display?: string }
  | { kind: 'startReview'; scope: string }
  | { kind: 'startSimplify'; target: string }
  | { kind: 'workspaceStatus' }
  | { kind: 'fileDiff'; path: string }
  | { kind: 'permission'; id: string; decision: PermissionDecision };

/** 下行推送通道的白名单(preload 据此收窄 renderer 可订阅的 channel)。 */
export type PushChannel = 'state' | 'event' | 'replay' | 'connection' | 'permission' | 'sessions';

export interface SubscribeResult {
  state: StateSnapshot;
  replayItems: TimelineItem[];
  connection: ConnectionState;
}

/**
 * serializeEvent(protocol.ts)后的 AgentEvent。error 事件里的 Error 实例过不了
 * structured clone,必须以 WireError 形态过 IPC,renderer 侧 deserializeEvent 复原。
 */
export type WireEvent = ReturnType<typeof serializeEvent>;
