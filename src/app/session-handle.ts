/**
 * TUI 消费会话的**窄腰接口**。
 *
 * bootstrap 出来的完整 `Session` 以**结构子类型**满足它;UI 测试的假 session
 * 也只需造这一份。这里只声明 TUI 真正碰到的成员,是把 UI 的依赖面钉死在
 * 类型里:给 Session 新增能力时,先想清楚 TUI 是否需要,需要才加进来——
 * 每多一个成员,每个 UI 测试的假 session 就多桩一个。
 *
 * 方法的类型就是实现的类型:曾经写成 `T | Promise<T>` 是为了同时容纳一个
 * 远程实现,那个实现已经没有了。调用方照旧可以 `await`(await 同步值无害)。
 */

import type { ModelMessage } from 'ai';
import type { EventBus } from '../core/events.js';
import type { Config, ReasoningEffort } from '../config/schema.js';
import type { ResolvedProvider } from '../config/load.js';
import type {
  ExtensionCommandInfo,
  ExtensionCommandOption,
  ExtensionStatusEntry,
  MessageRenderer,
  ToolRenderers,
  UiAnswer,
  UiRequest,
} from '../core/extension.js';
import type {
  UiCustomRequest,
  UiHost,
  UiSurfaces,
} from '../core/extension-types.js';
import type { ProviderModels } from '../model/registry.js';
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
  inject(text: string, images?: ImageAttachment[]): Promise<boolean>;
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
  switch(change: { provider?: string; model?: string; apiKey?: string }): ResolvedProvider;
  setReasoningEffort(level: ReasoningEffort): void;
  /** 所有已配置厂商的模型分组(`/models`),并发探测。 */
  listProviderModels(): Promise<ProviderModels[]>;
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
  /** 斜杠调用技能:激活+展开+跑一整轮。 */
  runSkill(name: string, args: string, options?: { display?: string }): Promise<void>;
  /**
   * 装配期攒下、必须让用户看到的提示(磁盘扩展加载失败、包不在盘上)。
   * bootstrap 里 emit 赶在任何订阅之前——所以由 App 挂载时自己来取。
   * 可选字段:UI 测试的假 session 不必造。
   */
  readonly startupNotices?: ReadonlyArray<{ level: 'warn' | 'info'; message: string }>;
  /** 扩展注册的斜杠命令投影(命令菜单用),同步读取。 */
  readonly extensionCommands: ExtensionCommandInfo[];
  /** 扩展贴在输入框上方的状态行,同步读取。 */
  readonly extensionStatus: ExtensionStatusEntry[];
  /** 扩展发布的结构化状态(key → 值,如 todo 清单),同步读取。 */
  readonly extensionState: Record<string, unknown>;
  /** 取一条扩展命令的选择器取值(每次现取)。 */
  commandOptions(name: string, path?: string[]): Promise<ExtensionCommandOption[]>;
  /** 命令表或状态行实质变化时通知。返回退订函数。 */
  extensionsChanged(listener: () => void): () => void;
  /** 执行扩展命令:处理器要发起一轮就 followUp,不在这里等整轮。 */
  runCommand(name: string, args: string): Promise<void>;
  /** 扩展向用户提的、尚未回答的问题(同步读取,变化经 extensionsChanged 通知)。 */
  readonly uiRequests: UiRequest[];
  /** 回答一个扩展提问。 */
  answerUi(id: string, answer: UiAnswer): void;
  /** TUI 挂上会话(有人在看、读写输入框草稿)。App 挂载时调,卸载时传 undefined。 */
  attachUi(host: UiHost | undefined): void;
  /** 带修饰键的组合先问扩展(键名由 shortcutOf 归一);认领返回 true。 */
  runShortcut(key: string): boolean;
  /** `ui.custom` 挂出来的组件(画第一条);done 之后经 resolveCustom 交回。 */
  readonly uiCustoms: UiCustomRequest[];
  resolveCustom(id: string, value: unknown): void;
  /** 扩展占用的界面区域(widget / header / footer / title)。 */
  readonly uiSurfaces: UiSurfaces;
  /** 工具的自定义画法,按工具名;变化经 extensionsChanged。 */
  readonly toolRenderers: ReadonlyMap<string, ToolRenderers>;
  /** 自定义消息的画法,按 customType。 */
  readonly messageRenderers: ReadonlyMap<string, MessageRenderer>;
  /** `/reload`:重载磁盘扩展。 */
  reloadExtensions(): Promise<{ loaded: string[]; failed: string[] }>;
  /**
   * `/simplify` 跑一轮代码清理并直接应用修复:与 /review 共用 git 收集器与
   * 失败 reason(UI 据此映射本地化提示)。
   */
  startSimplify(target: string, options?: { display?: string }): Promise<SimplifyStartResult>;
  dispose(): Promise<void>;
}
