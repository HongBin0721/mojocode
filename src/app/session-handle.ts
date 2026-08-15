/**
 * TUI 消费会话的**窄腰接口**。
 *
 * client-server 进程模型(对齐 opencode)引入后,TUI 面对的可能是:
 *  - 本进程 bootstrap 出来的完整 `Session`(MOJOCODE_NO_SERVER=1 的逃生口、
 *    UI 测试),或
 *  - `src/client/remote.ts` 里经 REST + SSE 镜像出来的远程会话。
 *
 * 两者都以**结构子类型**满足本接口——这里只声明 TUI 真正碰到的成员,是把
 * UI 的依赖面钉死在类型里(与 GoalControllerOptions 用 Pick 的道理相同)。
 * 给 Session 新增能力时,先想清楚 TUI 是否需要;需要才加进来,并同步在
 * remote.ts 里实现镜像/RPC。
 *
 * 同步 vs 异步:远程会话把同步读取(isRunning、todos、goal…)做成 SSE 驱动
 * 的本地镜像,读取保持同步;但**方法调用**是 RPC——凡是本地实现返回同步值
 * 而远程必须跑一趟 HTTP 的(inject / steer / switch),类型写成
 * `T | Promise<T>`,调用方一律 `await`(await 同步值是无害的)。
 */

import type { ModelMessage } from 'ai';
import type { EventBus, GoalStopReason, PermissionAsker } from '../core/events.js';
import type { Config, Permissions, ReasoningEffort } from '../config/schema.js';
import type { ResolvedProvider } from '../config/load.js';
import type { McpStatus } from '../mcp/client.js';
import type { TodoItem } from '../tools/index.js';
import type { GoalState, GoalStatus } from '../agent/goal.js';
import type { ProviderModels } from '../model/registry.js';
import type { DoctorReport } from './doctor.js';
import type { ImageAttachment } from './attachments.js';
import type { SkillCommandInfo } from '../skills/discovery.js';
import type { ReviewCommit, ReviewStartResult, ReviewTargets } from '../agent/review.js';

export interface RunOptions {
  display?: string;
  images?: ImageAttachment[];
}

export interface AgentHandle {
  readonly isRunning: boolean;
  readonly isCompacting: boolean;
  readonly history: ModelMessage[];
  run(text: string, options?: RunOptions): Promise<void>;
  inject(text: string, images?: ImageAttachment[]): boolean | Promise<boolean>;
  abort(): void;
  compact(): Promise<void>;
  setHistory(messages: ModelMessage[]): void;
}

export interface GoalHandle {
  readonly active: boolean;
  readonly busy: boolean;
  readonly state: Readonly<GoalState> | undefined;
  set(condition: string): void;
  clear(reason?: GoalStopReason): void;
  snapshot(): GoalStatus | undefined;
  steer(text: string, options?: RunOptions): boolean | Promise<boolean>;
  run(text: string, options?: RunOptions): Promise<void>;
}

export interface TodosHandle {
  get(): TodoItem[];
  subscribe(listener: (items: TodoItem[]) => void): () => void;
}

export interface GateHandle {
  setAsker(ask: PermissionAsker): void;
}

export interface StoreHandle {
  readonly id: string;
  /** 模型历史(压缩后是摘要+尾巴)。回退选择器等"喂给模型什么"的场景用它。 */
  readonly messages: ModelMessage[];
  /** 完整展示历史(压缩不缩减)。`/resume` 的时间线回放用它。 */
  readonly displayMessages: ModelMessage[];
  save(messages: ModelMessage[]): Promise<void>;
}

export interface SessionHandle {
  root: string;
  config: Config;
  readonly provider: ResolvedProvider;
  bus: EventBus;
  agent: AgentHandle;
  gate: GateHandle;
  todos: TodosHandle;
  goal: GoalHandle;
  mcpStatuses: McpStatus[];
  readonly store: StoreHandle;
  /** 返回值 TUI 只用到 fork 的 id,故收窄到最小面。 */
  newSession(): Promise<unknown>;
  resumeSession(idOrPrefix: string): Promise<unknown>;
  forkSession(): Promise<{ id: string }>;
  /** apiKey 仅在"刚就地输入了 key"的切换里出现:server 把它并入内存配置后解析。 */
  switch(change: { provider?: string; model?: string; apiKey?: string }): ResolvedProvider | Promise<ResolvedProvider>;
  setPermissions(permissions: Permissions): void;
  setPlan(active: boolean): void;
  setReasoningEffort(level: ReasoningEffort): void | Promise<void>;
  /** 所有已配置厂商的模型分组(`/models`):远程侧 RPC,server 侧并发探测。 */
  listProviderModels(): Promise<ProviderModels[]>;
  doctor(options: { offline: boolean }): Promise<DoctorReport>;
  refreshEnvironment(): Promise<void>;
  /** user-invocable 技能投影(命令菜单用),同步读取(远程侧走 SSE 镜像)。 */
  readonly skills: SkillCommandInfo[];
  /** 技能列表实质变化时通知(菜单据此重算)。返回退订函数。 */
  skillsChanged(listener: () => void): () => void;
  /** 强制重扫技能目录(`/skills`)。 */
  refreshSkills(): Promise<SkillCommandInfo[]>;
  /** 斜杠调用技能:激活+展开+跑一整轮,远程侧是 deferred RPC。 */
  runSkill(name: string, args: string, options?: { display?: string }): Promise<void>;
  /**
   * `/review` 二级选择器的数据源(当前分支 + 其余本地分支)。git 在 server
   * 侧跑——`--attach` 时仓库不在 UI 这台机器上;远程侧普通即时 RPC。
   */
  reviewTargets(): Promise<ReviewTargets>;
  /** `/review` 提交选择器数据源(最近 N 个提交)。远程侧普通即时 RPC。 */
  reviewCommits(): Promise<ReviewCommit[]>;
  /**
   * `/review` 跑一轮代码评审:server 侧收集 git 摘要、组稿罐装提示词后
   * agent.run。失败以 reason 代码返回(不抛异常),UI 据此映射本地化提示;
   * 远程侧是 deferred RPC(包 agent.run,与 runSkill 同理)。
   */
  startReview(scope: string, options?: { display?: string }): Promise<ReviewStartResult>;
  dispose(): Promise<void>;
}
