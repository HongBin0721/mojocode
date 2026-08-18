/**
 * server ↔ TUI 客户端之间的线上协议(对齐 opencode 的进程模型:HTTP server
 * + 瘦客户端,REST + SSE)。
 *
 * 本文件只有类型与纯函数,server 与 client 双方共用;不 import UI 框架、
 * 不 import OpenTUI,也不做任何 I/O。
 *
 * 三类下行消息(SSE `/event` 流):
 *  - `event`:AgentEvent 原样转发(error 事件的 Error 拆成可序列化形态);
 *  - `state`:会话状态快照——client 端所有**同步读取**(isRunning、权限、
 *    provider、todos、goal…)都从这份镜像取,server 在任何可能改变它的时刻
 *    重算并按需推送;
 *  - `call-result`:长任务(agent.run / goal.run / compact)的完成回执。
 *    这些调用可能跑几分钟到几小时,POST 立即回执 ack,完成经 SSE 送达,
 *    避免长连接被各层 HTTP 超时(undici headersTimeout 等)拦腰斩断。
 *
 * 上行:`POST /call` 统一承载方法调用,`POST /permission` 回复授权决定。
 */

import type { ModelMessage } from 'ai';
import type { AgentEvent, ContextUsage, PermissionDecision, PermissionRequest } from '../core/events.js';
import type { Config } from '../config/schema.js';
import type { ResolvedProvider } from '../config/load.js';
import type { McpStatus } from '../mcp/client.js';
import type { TodoItem } from '../tools/index.js';
import type { GoalStatus } from '../agent/goal.js';
import type { SkillCommandInfo } from '../skills/discovery.js';
import type { ChangedFileEntry } from '../session/store.js';

export interface WireError {
  name: string;
  message: string;
}

/** 会话状态快照。字段面 = TUI 对 Session 的全部同步读取。 */
export interface StateSnapshot {
  root: string;
  /** apiKey / headers 已抹除:client 永远不需要凭据(listProviderModels 也在 server 侧跑)。 */
  provider: ResolvedProvider;
  /** 凭据已抹除:providers.*.apiKey、search.apiKey、mcpServers.*.env/.headers(见 redactConfig)。 */
  config: Config;
  mcpStatuses: McpStatus[];
  storeId: string;
  agent: {
    isRunning: boolean;
    isCompacting: boolean;
    historyLength: number;
    /**
     * 上下文占用(provider 上报数,换史后为本地估算)。可选:旧 server
     * 没有该字段,client 侧回退到 `{ used: 0 }`——计量条退回旧行为,等
     * 下一个 step-end 带回真实值。
     */
    contextUsage?: { used: number; window: number };
  };
  goal: {
    active: boolean;
    busy: boolean;
    /** goal.snapshot() 的即时值;client 按 sentAt 外推 elapsedMs。 */
    status?: GoalStatus;
    /** 恢复而来、尚未开跑(App 挂载时据此补一条提示)。 */
    restored?: boolean;
  };
  todos: TodoItem[];
  /**
   * user-invocable 技能的元数据投影(name/description/argument-hint)。
   * 只有元数据:正文可能含工作区任何内容且体积不限,永不进快照——
   * 调用走 runSkill RPC,在 server 侧展开。
   */
  skills: SkillCommandInfo[];
  /**
   * 本会话经 write/edit 落地过的文件(任务视角变更索引,按 path 排序保
   * snapshotKey 稳定)。可选:旧 server 没有该字段,client 回退 `[]`;
   * git 真相仍以 workspaceStatus 为准(bash 造成的变更不在此列)。
   */
  changedFiles?: ChangedFileEntry[];
  /** server 侧的取样时刻,client 外推 goal 计时用。 */
  sentAt: number;
}

export type ServerMessage =
  | { kind: 'event'; event: unknown }
  | { kind: 'state'; state: StateSnapshot }
  | { kind: 'call-result'; callId: string; ok: boolean; value?: unknown; error?: WireError }
  /**
   * 断点续传失败的标记:client 带着 Last-Event-ID 重连,但对应序号已滚出
   * server 的重放缓冲(或来自另一个 server 实例)。client 收到它才告警
   * 「记录不完整」并刷新镜像;无缝重放成功时不发,重连全程静默。
   */
  | { kind: 'gap' };

export interface CallRequest {
  /** client 生成;deferred 方法靠它对上 call-result。 */
  id: string;
  method: string;
  args?: unknown;
}

export type CallResponse =
  | { ok: true; value?: unknown; deferred?: boolean }
  | { ok: false; error: WireError };

export interface PermissionReply {
  id: string;
  decision: PermissionDecision;
}

/** 这些方法可能一跑几小时:POST 立即 ack,完成经 SSE call-result 送达。 */
export const DEFERRED_METHODS = new Set([
  'run',
  'goalRun',
  'compact',
  'runSkill',
  'startReview',
  'startSimplify',
]);

/**
 * deferred 里"本身就是一整轮 agent.run"的方法。客户端(remote.ts)据此点亮
 * 乐观 run 标志——漏一边就是"ack 迟到把标志置回、永远没人清"的卡死,所以
 * 与 DEFERRED_METHODS 放在一起:新增这类方法时两张表要一起动。goalRun 也
 * 占 run 标志但还额外点亮 goal,调用处单独判;compact 点亮的是 compact。
 */
export const RUN_LIKE_METHODS = new Set(['run', 'runSkill', 'startReview', 'startSimplify']);

export function toWireError(error: unknown): WireError {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

/** AgentEvent → 可 JSON 化。只有 error 事件带 Error 实例,其余本就是纯数据。 */
export function serializeEvent(event: AgentEvent): unknown {
  if (event.type === 'error') {
    return { type: 'error', error: toWireError(event.error), recoverable: event.recoverable };
  }
  return event;
}

/** 线上形态 → AgentEvent。error 事件把 WireError 复原成 Error 实例。 */
export function deserializeEvent(raw: unknown): AgentEvent {
  const event = raw as AgentEvent & { error?: WireError | Error };
  if (event.type === 'error' && event.error && !(event.error instanceof Error)) {
    const wire = event.error as WireError;
    const revived = new Error(wire.message);
    revived.name = wire.name;
    return { type: 'error', error: revived, recoverable: (event as { recoverable: boolean }).recoverable };
  }
  return event as AgentEvent;
}

/** 抹除凭据后的 provider:结构与 ResolvedProvider 相同,client 可原样消费。 */
export function redactProvider(provider: ResolvedProvider): ResolvedProvider {
  return { ...provider, apiKey: '', headers: {} };
}

/**
 * 抹除全部会随配置外传的凭据。三处,缺一不可:
 * - `providers.*.apiKey`、`search.apiKey`(auth 向导写进配置文件的);
 * - **`mcpServers.*.env` / `.headers`**——stdio server 的环境变量和 http
 *   server 的请求头是放 `GITHUB_TOKEN`、`Authorization: Bearer …` 的常规
 *   位置。managed 子进程走环回还好,但 `serve --host <非环回>` + `--attach`
 *   是明确支持的用法,那时整份配置是真的过网。值一律替换成空串而不是删键:
 *   client 侧的 /doctor、/mcp 只看结构与键名,不碰值。
 */
export function redactConfig(config: Config): Config {
  const redactRecord = (record: Record<string, string> | undefined) =>
    record ? Object.fromEntries(Object.keys(record).map((key) => [key, ''])) : record;
  return {
    ...config,
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([id, value]) => [
        id,
        value && 'apiKey' in value && value.apiKey ? { ...value, apiKey: '' } : value,
      ]),
    ),
    search: config.search.apiKey ? { ...config.search, apiKey: '' } : config.search,
    mcpServers: Object.fromEntries(
      // `?? {}`:schema 保证有默认值,但这是 server 进程的热路径,
      // 一个畸形配置不该让整个连接崩掉。
      Object.entries(config.mcpServers ?? {}).map(([name, server]) => [
        name,
        server.type === 'stdio'
          ? { ...server, ...(server.env ? { env: redactRecord(server.env)! } : {}) }
          : { ...server, ...(server.headers ? { headers: redactRecord(server.headers)! } : {}) },
      ]),
    ),
  };
}

/**
 * 快照的稳定键:用于变化检测。goal 的 elapsedMs 与 sentAt 每毫秒都在变,
 * 不剔除的话每条事件都会带一次全量推送。
 */
export function snapshotKey(state: StateSnapshot): string {
  return JSON.stringify({
    ...state,
    sentAt: 0,
    goal: {
      ...state.goal,
      status: state.goal.status ? { ...state.goal.status, elapsedMs: 0, tokens: 0 } : undefined,
    },
  });
}

export interface HistoryPayload {
  messages: ModelMessage[];
  /**
   * 完整展示历史(压缩不缩减,含未落盘的当轮后缀)。可选:旧 server 没有
   * 该字段,client 侧回退到 messages。
   */
  displayMessages?: ModelMessage[];
}
