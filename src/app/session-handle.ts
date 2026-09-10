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
 * 同步 vs 异步:远程会话把同步读取(isRunning、权限、扩展状态…)做成 SSE 驱动
 * 的本地镜像,读取保持同步;但**方法调用**是 RPC——凡是本地实现返回同步值
 * 而远程必须跑一趟 HTTP 的(inject / steer / switch),类型写成
 * `T | Promise<T>`,调用方一律 `await`(await 同步值是无害的)。
 */

import type { ModelMessage } from 'ai';
import type { EventBus } from '../core/events.js';
import type { Config, ReasoningEffort } from '../config/schema.js';
import type { ResolvedProvider } from '../config/load.js';
import type {
  ExtensionCommandInfo,
  ExtensionCommandOption,
  ExtensionStatusEntry,
} from '../core/extension.js';
import type { ModelTestResult, ProviderModels } from '../model/registry.js';
import type { ModelCapabilities } from '../model/catalog.js';
import type { DoctorReport } from './doctor.js';
import type { ImageAttachment } from './attachments.js';
import type { SkillCommandInfo } from '../skills/discovery.js';
import type { SimplifyStartResult } from '../agent/simplify.js';

export interface RunOptions {
  display?: string;
  images?: ImageAttachment[];
}

export interface AgentHandle {
  readonly isRunning: boolean;
  readonly isCompacting: boolean;
  readonly history: ModelMessage[];
  /**
   * 上下文占用(已用/窗口)。provider 上报数优先;换史后(恢复会话、回退
   * 截断)回落到本地估算,直到下一轮 step-end——恢复会话的计量条因此不会
   * 显示误导性的 0。远程侧随 state 快照镜像。
   */
  readonly contextUsage: { used: number; window: number };
  run(text: string, options?: RunOptions): Promise<void>;
  inject(text: string, images?: ImageAttachment[]): boolean | Promise<boolean>;
  abort(): void;
  compact(): Promise<void>;
  setHistory(messages: ModelMessage[]): void;
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
  readonly store: StoreHandle;
  /** 返回值 TUI 只用到 fork 的 id,故收窄到最小面。 */
  newSession(): Promise<unknown>;
  resumeSession(idOrPrefix: string): Promise<unknown>;
  forkSession(): Promise<{ id: string }>;
  /** apiKey 仅在"刚就地输入了 key"的切换里出现:server 把它并入内存配置后解析。 */
  switch(change: { provider?: string; model?: string; apiKey?: string }): ResolvedProvider | Promise<ResolvedProvider>;
  setReasoningEffort(level: ReasoningEffort): void | Promise<void>;
  /** 所有已配置厂商的模型分组(`/models`):远程侧 RPC,server 侧并发探测。 */
  listProviderModels(): Promise<ProviderModels[]>;
  /** GUI「测试模型」:server 侧向对话端点发一次最小补全,失败原因随结果带回。 */
  testModel(providerId: string, modelId: string): Promise<ModelTestResult>;
  /** 逐模型能力(models.dev 目录):思考档位/窗口/输出上限;库里没有返回 undefined。 */
  modelCapabilities(providerId: string, modelId: string): Promise<ModelCapabilities | undefined>;
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
   * 装配期攒下、必须让用户看到的提示(磁盘扩展加载失败、包不在盘上)。
   *
   * **远程模式为空**:那条路上 server 把它们经 SSE 补发到 bus,渲染层照常
   * 收到。进程内模式(`MOJOCODE_NO_SERVER=1`)没有那一跳,bootstrap 里 emit
   * 又赶在任何订阅之前——所以只能由 App 挂载时自己来取。可选字段:
   * RemoteSession 不实现它。
   */
  readonly startupNotices?: ReadonlyArray<{ level: 'warn' | 'info'; message: string }>;
  /** 扩展注册的斜杠命令投影(命令菜单用),同步读取(远程侧走 SSE 镜像)。 */
  readonly extensionCommands: ExtensionCommandInfo[];
  /** 扩展贴在输入框上方的状态行,同步读取(远程侧走 SSE 镜像,since 已校时)。 */
  readonly extensionStatus: ExtensionStatusEntry[];
  /** 扩展发布的结构化状态(key → 值,如 todo 清单),同步读取。 */
  readonly extensionState: Record<string, unknown>;
  /** 取一条扩展命令的选择器取值(每次现取)。 */
  commandOptions(name: string, path?: string[]): Promise<ExtensionCommandOption[]>;
  /** 命令表或状态行实质变化时通知。返回退订函数。 */
  extensionsChanged(listener: () => void): () => void;
  /** 执行扩展命令:即时 RPC,处理器要发起一轮就 followUp,忙碌状态随 state 推送带回。 */
  runCommand(name: string, args: string): Promise<void>;
  /**
   * `/simplify` 跑一轮代码清理并直接应用修复:与 /review 共用 git 收集器与
   * 失败 reason(UI 据此映射本地化提示);远程侧同样走 deferred RPC。
   */
  startSimplify(target: string, options?: { display?: string }): Promise<SimplifyStartResult>;
  dispose(): Promise<void>;
}
