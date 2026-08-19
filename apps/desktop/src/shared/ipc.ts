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
import type { Permissions, ProviderConfig, ReasoningEffort } from '@core/schema';
import type { ImageAttachment } from '@core/attachments';
import type { TimelineItem } from '@core/types';

/**
 * 多任务信封:所有 per-task 下行通道(state/event/replay/connection/permission)
 * 的载荷都包一层 taskId,renderer 侧按 id 分桶。通道拓扑保持静态——preload 的
 * 白名单映射不随任务数变化(动态通道名会让收窄失效且无法枚举测试)。
 */
export interface TaskScoped<T> {
  taskId: string;
  data: T;
}

/**
 * 任务(= 会话)的生命周期状态:starting(sidecar 握手中)/ connected /
 * lost(sidecar 意外退出)/ dormant(无进程,历史在磁盘,点开即复活)。
 */
export type TaskStatus = 'starting' | 'connected' | 'lost' | 'dormant';

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
  /** 归档时间(ISO)。缺省 = 未归档;归档视图按它过滤与排序。 */
  archivedAt?: string;
}

/**
 * 任务列表行(tasks 通道全量推):SessionStore.list() 的 meta ∪ 运行时状态。
 * dormant 行只有 meta 部分有意义(isRunning 恒 false)。
 */
export interface TaskSummary extends SessionMetaSummary {
  status: TaskStatus;
  isRunning: boolean;
  /** 有待决审批(后台任务行的角标数据源)。 */
  hasPendingPermission: boolean;
  lastActivityAt?: number;
}

/** 文件预览结果。形状复制自根仓库 src/app/workspace-read.ts 的 FileContent。 */
export type FileReadFailure = 'not-found' | 'binary' | 'too-large' | 'denied' | 'is-directory';

export interface FileContentSummary {
  ok: boolean;
  reason?: FileReadFailure;
  path: string;
  content?: string;
  size: number;
  truncated: boolean;
}

/** 文件树数据源(listFiles RPC):工作区扁平相对路径清单。 */
export interface WorkspaceFilesSummary {
  files: string[];
  truncated: boolean;
}

/** git 写操作结果。形状复制自根仓库 src/agent/workspace-write.ts 的 GitOpResult。 */
export type GitOpFailure =
  | 'no-repo'
  | 'dirty'
  | 'unknown-branch'
  | 'invalid-name'
  | 'clean-tree'
  | 'no-commit'
  | 'git-error';

export interface GitOpSummary {
  ok: boolean;
  reason?: GitOpFailure;
  branch?: string;
  sha?: string;
  /** git-error 时的 stderr 首行(英文,单行截断)。 */
  detail?: string;
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
  models: Array<{
    id: string;
    ownedBy?: string;
    /** 该条目配置了思考(档位或自定义参数)——模型菜单行的「思考」tag。 */
    thinks?: boolean;
  }>;
  error?: string;
}

/** 逐模型能力(models.dev)。形状复制自根仓库 src/model/catalog.ts 的 ModelCapabilities。 */
export interface ModelCapabilitiesSummary {
  contextWindow?: number;
  maxOutputTokens?: number;
  /**
   * 生效可选思考档位('auto' 不在内)。server 侧已做完回退与 wire 过滤,
   * 直接渲染即可:`[]` = 该模型不推理(思考 chip 整个不显示),
   * `undefined` = 连 provider 都解析不了,退回全量枚举。
   */
  efforts?: ReasoningEffort[];
}

/** 「测试模型」结果。形状复制自根仓库 src/model/registry.ts 的 ModelTestResult。 */
export interface ModelTestSummary {
  ok: boolean;
  status?: number;
  /** 失败原因(英文,端点原文),单行。 */
  error?: string;
  durationMs: number;
}

/** 分支菜单数据源。形状复制自根仓库 src/agent/review.ts 的 ReviewTargets。 */
export interface ReviewTargetsSummary {
  isRepo: boolean;
  /** detached HEAD 时为真(uncommitted / commit 仍可用)。 */
  detached: boolean;
  currentBranch?: string;
  /** 除当前分支外的本地分支,按最近提交时间倒序。 */
  branches: Array<{ name: string; subject: string }>;
}

export const IPC_CHANNELS = {
  subscribe: 'bridge:subscribe',
  rpc: 'bridge:rpc',
  state: 'bridge:state',
  event: 'bridge:event',
  replay: 'bridge:replay',
  connection: 'bridge:connection',
  permission: 'bridge:permission',
  /** 任务列表(TaskSummary[] 全量推),TaskManager 拥有;替代旧 sessions 通道。 */
  tasks: 'bridge:tasks',
  /* 下面这些是 main 本地能力(Electron dialog / TaskManager 生命周期),不进
   * bridge 的 RPC 白名单——bridge 保持 electron-free 可测。「切工作区」已随
   * 多任务退役:每个任务自带 root,换项目 = 在那个 root 新建/打开任务。 */
  pickDirectory: 'desktop:pick-directory',
  taskCreate: 'task:create',
  taskOpen: 'task:open',
  taskClose: 'task:close',
  taskFocus: 'task:focus',
  revealPath: 'desktop:reveal-path',
  openPath: 'desktop:open-path',
} as const;

export type ConnectionState = 'connecting' | 'connected' | 'lost';

export type RpcRequest =
  | { kind: 'run'; text: string; options?: { display?: string; images?: ImageAttachment[] } }
  | { kind: 'abort' }
  | { kind: 'compact' }
  /* 换会话三连(newSession/resumeSession/forkSession)已退役:一个 sidecar
   * 终生绑定一个会话,新任务/打开历史/fork 一律走 task:create / task:open。 */
  | { kind: 'switch'; change: { provider?: string; model?: string; apiKey?: string } }
  /* 设置页·模型设置:保存/删除 provider 条目(server 侧落盘全局配置)。
   * config 只含用户真正改过的键——快照里的配置是脱敏副本,整对象回写会
   * 用空值覆盖真 key。 */
  | { kind: 'saveProvider'; id: string; config: ProviderConfig }
  | { kind: 'deleteProvider'; id: string }
  | { kind: 'setPermissions'; permissions: Permissions }
  | { kind: 'setPlan'; active: boolean }
  | { kind: 'setReasoningEffort'; level: ReasoningEffort }
  | { kind: 'listProviderModels' }
  /* 设置页·模型行的「测试模型」:server 侧发一次最小补全验证连通性。 */
  | { kind: 'testModel'; id: string; model: string }
  /* 逐模型能力(models.dev 目录):思考档位与窗口/输出上限,查不到返回 undefined。 */
  | { kind: 'modelCapabilities'; id: string; model: string }
  | { kind: 'runSkill'; name: string; args: string; display?: string }
  | { kind: 'startReview'; scope: string }
  | { kind: 'startSimplify'; target: string }
  | { kind: 'workspaceStatus' }
  | { kind: 'fileDiff'; path: string }
  /* 任务列表的会话生命周期:归档/改名/删除(活跃会话拒删,server 侧把关)。 */
  | { kind: 'archiveSession'; id: string; archived: boolean }
  | { kind: 'renameSession'; id: string; title: string }
  | { kind: 'deleteSession'; id: string }
  /* 右侧面板·文件 tab:工作区文件清单与单文件预览(server 侧读盘)。 */
  | { kind: 'listFiles' }
  | { kind: 'readFile'; path: string }
  /* diff 面板批准流与分支切换的 git 写操作(用户显式操作,server 侧执行)。 */
  | { kind: 'switchBranch'; name: string }
  | { kind: 'commitAll'; message: string }
  | { kind: 'undoCommit' }
  | { kind: 'discardAll' }
  /* 分支菜单数据源(核心 reviewTargets:当前分支 + 本地分支列表)。 */
  | { kind: 'reviewTargets' }
  | { kind: 'permission'; id: string; decision: PermissionDecision };

export type RpcKind = RpcRequest['kind'];

/**
 * kind → 响应类型映射(与 main/bridge.ts dispatchRpc 各 case 的实际返回值
 * 逐一核对,那边保持 Promise<unknown>——switch 语句做不了 kind 关联收窄,
 * 这里才是契约锚点)。`unknown` = wire 上有值但 GUI 契约不消费(要用先建
 * Summary)。索引访问本身就是完整性检查:RpcRequest 新增 kind 而这里漏写,
 * RpcResult<K> 直接编译报错。
 */
export interface RpcResultMap {
  run: void; // deferred:ack 后 resolve undefined
  abort: void;
  compact: void;
  switch: unknown; // wire 上是 ResolvedProvider,GUI 不消费
  saveProvider: void;
  deleteProvider: void;
  setPermissions: void;
  setPlan: void;
  setReasoningEffort: void;
  listProviderModels: ProviderModelsSummary[];
  testModel: ModelTestSummary;
  modelCapabilities: ModelCapabilitiesSummary | undefined;
  runSkill: void;
  startReview: unknown; // deferred 整轮结果,GUI fire-and-forget
  startSimplify: unknown;
  workspaceStatus: WorkspaceStatusSummary;
  fileDiff: FileDiffSummary;
  archiveSession: SessionMetaSummary;
  renameSession: SessionMetaSummary;
  deleteSession: void;
  listFiles: WorkspaceFilesSummary;
  readFile: FileContentSummary;
  switchBranch: GitOpSummary;
  commitAll: GitOpSummary;
  undoCommit: GitOpSummary;
  discardAll: GitOpSummary;
  reviewTargets: ReviewTargetsSummary;
  /** false = 请求 id 已过期(bridge 侧 pendingPermission 不匹配)。 */
  permission: boolean;
}

export type RpcResult<K extends RpcKind> = RpcResultMap[K];

/** 下行推送通道的白名单(preload 据此收窄 renderer 可订阅的 channel)。 */
export const PUSH_CHANNELS = [
  'state',
  'event',
  'replay',
  'connection',
  'permission',
  'tasks',
] as const;

export type PushChannel = (typeof PUSH_CHANNELS)[number];

/**
 * 逻辑名 → 物理通道。preload 的 on() 唯一取用点:曾因漏映射订阅到永无流量
 * 的通道,下行推送全部静默丢失(首屏靠 subscribe 返回值正常,此后一概不
 * 回显)。未知名直接 throw,比返回 undefined 后静默订空强。
 */
export function pushChannelOf(channel: PushChannel): string {
  if (!(PUSH_CHANNELS as readonly string[]).includes(channel)) {
    throw new Error(`未知下行通道:${channel as string}`);
  }
  return IPC_CHANNELS[channel];
}

/** 一个活跃任务的即时状态(subscribe 返回;replayItems 只有聚焦任务带)。 */
export interface LiveTaskState {
  taskId: string;
  state: StateSnapshot;
  connection: ConnectionState;
  permission?: PermissionRequest;
  replayItems?: TimelineItem[];
}

export interface SubscribeResult {
  /** undefined = 会话列表读取失败(降级提示)。 */
  tasks: TaskSummary[] | undefined;
  focusedTaskId: string | undefined;
  live: LiveTaskState[];
}

/**
 * serializeEvent(protocol.ts)后的 AgentEvent。error 事件里的 Error 实例过不了
 * structured clone,必须以 WireError 形态过 IPC,renderer 侧 deserializeEvent 复原。
 */
export type WireEvent = ReturnType<typeof serializeEvent>;
