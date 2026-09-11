/**
 * 扩展 API(Pi 的 ExtensionAPI 的 mojocode 版):功能从核心搬出去之后与宿主
 * 打交道的**唯一**面。扩展只拿这个对象,不碰 Session / Agent / Store 本体。
 *
 * 成员表与 Pi 的 ExtensionAPI **同名同义**(registerTool / registerCommand /
 * registerFlag / sendMessage 语义的 run + followUp / appendEntry / exec /
 * events / getAllTools / setActiveTools / setModel / setThinkingLevel /
 * compact / getContextUsage / setSessionName …),处理器的第二个参数是 Pi
 * 同形的 `ctx`(cwd / hasUI / isIdle / abort / ui.*)。扩展与 TUI 跑在
 * **同一个进程**里(Pi 的形态),所以渲染那一族也在:`ui.custom` 挂一个
 * 自己处理按键的组件、`ui.setWidget / setHeader / setFooter / setTitle /
 * setWorkingMessage / setEditorComponent / editor / theme / pasteToEditor`、
 * 工具的 `renderCall / renderResult`。组件的形状是 Pi 的(渲染成行 + 处理
 * 按键),不是 pi-tui 的类;核心只传递这些对象,画出来是 TUI 的事。
 * `ctx.sessionManager` / `ctx.modelRegistry` 也在,但收窄成读口。
 * 刻意没有的:会话树、`registerProvider`、`project_trust`。
 *
 * 一方扩展静态打包(src/extensions/index.ts),磁盘扩展由 extensions/loader.ts
 * 三层发现(包 / 全局目录 / 项目目录 / 配置 `extensions` / `-e`),bootstrap
 * 逐个 setup,两者拿的是同一份 API。headless(`-p`)下没有界面,提问按缺省
 * 兑现、界面区域的设置被忽略。
 */

import type { LanguageModel, ModelMessage, Tool } from 'ai';
import type { AgentEvent } from './events.js';
import type { HookRegistry } from './hooks.js';
import type { Config, ReasoningEffort } from '../config/schema.js';
import type { SessionCustomRecord, SessionMeta } from '../session/store.js';
import type { ImageAttachment } from '../app/attachments.js';
import type { ModelCapabilities } from '../model/catalog.js';
import type { KnownModel, ProviderModels } from '../model/registry.js';
// 过线的那几个类型住在 Node-free 的 extension-types.ts,理由见那边的文件头;
// 这里原样 re-export,扩展作者仍然只从 core/extension.js 一处 import。
import type {
  ComponentFactory,
  ComponentHost,
  CustomMessageInfo,
  EditorComponentFactory,
  ExtensionCommandInfo,
  ExtensionCommandOption,
  ExtensionComponent,
  ExtensionEditorComponent,
  ExtensionKey,
  ExtensionShortcutInfo,
  ExtensionStatusEntry,
  ExtensionSurface,
  ExtensionTheme,
  MessageRenderer,
  PiToolResult,
  ToolRenderers,
  ToolScope,
  UiAnswer,
  UiRequest,
} from './extension-types.js';

export { selectList, textInput } from './ui-kit.js';
export type { SelectListOptions, TextInputOptions } from './ui-kit.js';
export type {
  ComponentFactory,
  ComponentHost,
  CustomMessageInfo,
  EditorComponentFactory,
  ExtensionCommandInfo,
  ExtensionCommandOption,
  ExtensionComponent,
  ExtensionEditorComponent,
  ExtensionKey,
  ExtensionShortcutInfo,
  ExtensionStatusEntry,
  ExtensionSurface,
  ExtensionTheme,
  MessageRenderer,
  PiToolResult,
  ToolRenderers,
  ToolScope,
  UiAnswer,
  UiRequest,
};

export interface ExtensionRunOptions {
  display?: string;
  images?: ImageAttachment[];
}

/** 返回 undefined = 这个作用域里不提供该工具(如 explore 不给有副作用的工具)。 */
export type ExtensionToolFactory = (scope: ToolScope) => Tool | undefined;

/**
 * 工具在系统提示词里的自述(Pi 的 promptSnippet / promptGuidelines):宿主
 * 把所有已注册、当前激活的扩展工具的 snippet 汇成一节「Extension tools」、
 * guidelines 汇成一节要点,挂在 before_agent_start 之前——提示词与实际注册
 * 的工具永远一致,扩展不必自己再拼一段。
 */
export interface ExtensionToolMeta extends ToolRenderers {
  promptSnippet?: string;
  promptGuidelines?: string[];
}

/**
 * Pi 形状的工具定义:`registerTool(definition)` 接受它,宿主经
 * extensions/tool-adapter.ts 转成 AI SDK 的 Tool。`parameters` 是 JSON Schema
 * (TypeBox 的 schema 本身就是),`execute` 与 Pi 同签名;`renderCall` /
 * `renderResult` 返回字符串行(带 ANSI 也行),TUI 用它们替换时间线里的缺省
 * 画法。`scope` 是 mojocode 的补充:按 ToolScope 决定给不给子 agent,缺省全给。
 */
export interface ExtensionToolDefinition extends ToolRenderers {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: (partial: unknown) => void,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
  promptSnippet?: string;
  promptGuidelines?: string[];
  scope?: (scope: ToolScope) => boolean;
}

/**
 * 扩展与界面打交道(Pi 的 ctx.ui)。提问类(select / confirm / input / custom)
 * 在没有前端看着(`hasUI` 为假,即 headless)时立即按缺省兑现——select /
 * input / custom 给 undefined、confirm 给 false,扩展按「用户没答」处理即可;
 * 区域类(setWidget / setHeader / setFooter / setTitle)在 headless 下被忽略。
 */
export interface ExtensionUI {
  select(title: string, items: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  /** 多行编辑框(Pi 的 ctx.ui.editor):回车提交,行尾 `\\` + 回车换行;esc 为 undefined。 */
  editor(title: string, prefill?: string): Promise<string | undefined>;
  /**
   * 挂一个自己画、自己处理按键的组件(Pi 的 ctx.ui.custom):它顶掉输入框、
   * 独占键盘,`done(value)` 收尾并把 value 交回;会话关闭时以 undefined 收尾。
   */
  custom<T>(
    factory: (host: ComponentHost, done: (value: T) => void) => ExtensionComponent,
  ): Promise<T | undefined>;
  /** 输入框上方的一块小部件:一组行,或按需重画的组件;undefined 清除。 */
  setWidget(key: string, surface: ExtensionSurface | undefined): void;
  /** 屏幕顶部(时间线之上)的一块;undefined 清除。 */
  setHeader(surface: ExtensionSurface | undefined): void;
  /** 替换底栏;undefined 恢复缺省底栏。 */
  setFooter(surface: ExtensionSurface | undefined): void;
  /** 终端窗口标题;undefined 恢复。 */
  setTitle(title: string | undefined): void;
  /** 工作状态线里替换「思考中 / 回复中」的文字(Pi 的 setWorkingMessage);undefined 恢复。 */
  setWorkingMessage(message: string | undefined): void;
  /**
   * 顶替缺省输入框的编辑器组件(Pi 的 setEditorComponent):工厂收 host 与
   * `submit(text)`,组件自己画、自己收键,`submit` 与在缺省输入框回车同一条路。
   * undefined 恢复缺省输入框。
   */
  setEditorComponent(factory: EditorComponentFactory | undefined): void;
  /** 给行上色的主题面(Pi 的 ctx.ui.theme),与组件的 `host.theme` 同一份。 */
  readonly theme: ExtensionTheme;
  /** 输入框当前草稿(headless 恒为空串)。 */
  getEditorText(): string;
  /** 覆盖输入框草稿(headless 忽略)。 */
  setEditorText(text: string): void;
  /** 在光标处插入一段文本(Pi 的 pasteToEditor;headless 忽略)。 */
  pasteToEditor(text: string): void;
  /** 与 api.notify 同一条路,参数顺序照 Pi(message 在前)。 */
  notify(message: string, level?: 'info' | 'warn'): void;
}

/** 扩展注册的快捷键(Pi 的 registerShortcut)。 */
export interface ExtensionShortcutOptions {
  description: string;
  handler: (ctx: ExtensionContext) => void | Promise<void>;
}

/**
 * 处理器(钩子 / 命令)的第二个参数,与 Pi 的 ctx 同形。成员与 ExtensionAPI
 * 上的同名成员是同一份实现——它存在只是为了让「只拿到 handler 没拿到
 * api」的代码也够得着宿主。
 */
export interface ExtensionContext {
  /** 工作区根目录(Pi 叫 cwd)。 */
  readonly cwd: string;
  /** 此刻有没有前端在看(TUI 挂着)。 */
  readonly hasUI: boolean;
  /** `tui` 是全屏界面,`print` 是 `-p` headless。 */
  readonly mode: 'tui' | 'print';
  /** 空闲 = 没有链条在跑、也没有压缩在跑(与 `waitForIdle` 同一判据)。 */
  isIdle(): boolean;
  abort(): void;
  /** 等到 agent 空闲;已空闲则立即兑现。 */
  waitForIdle(): Promise<void>;
  /** 丢弃当前对话,开一个全新会话(与 `/new` 同一条路)。 */
  newSession(): Promise<void>;
  /** 把当前对话分叉进新的会话 id(`/fork`);`session_before_fork` 可取消。 */
  fork(): Promise<{ id: string }>;
  /** 切到另一个已存会话(`/resume`,接 id 或前缀);`session_before_switch` 可取消。 */
  switchSession(idOrPrefix: string): Promise<void>;
  model(modelId?: string): LanguageModel;
  readonly config: Config;
  /** 当前会话的只读视图(Pi 的 ctx.sessionManager,收窄到读口)。 */
  readonly sessionManager: ExtensionSessionManager;
  /** 已配置的 provider / 模型表(Pi 的 ctx.modelRegistry)。 */
  readonly modelRegistry: ExtensionModelRegistry;
  readonly ui: ExtensionUI;
}

/**
 * Pi 的 `ctx.sessionManager` 在这里的形状:**只读**。写入走 API 上的成员
 * (`appendEntry` / `setSessionName` / `newSession` / `fork` / `switchSession`),
 * 会话文件的形状不对扩展开放——那是核心的持久化细节,不是扩展面。
 */
export interface ExtensionSessionManager {
  getSessionId(): string;
  getSessionName(): string;
  /** 自定义记录(kind custom),不给 type 就是全部,写入顺序。 */
  getEntries(type?: string): SessionCustomRecord[];
  /** 模型历史(压缩后是摘要 + 尾巴);与 `api.history()` 同源。 */
  getHistory(): ModelMessage[];
  /** 完整展示历史(压缩不缩减)。 */
  getDisplayHistory(): ModelMessage[];
  /** 本工作区的会话列表(会话选择器同款)。 */
  listSessions(): Promise<SessionMeta[]>;
}

/**
 * 模型表里的一条。就是 `model/registry.ts` 的 `KnownModel`——同一个形状写两遍
 * 的话,给它加一个字段要在两处各写一笔,而扩展拿到的正是那边算出来的对象。
 */
export type ExtensionModelEntry = KnownModel;

/**
 * Pi 的 `ctx.modelRegistry` 在这里的形状:静态部分(配置 + 预设)同步读,
 * 活的部分(`/models` 的在线探测、models.dev 的能力目录)异步。
 */
export interface ExtensionModelRegistry {
  getCurrent(): { provider: string; model: string };
  /** 已配置(有 key / 有 baseURL)的 provider id,当前的排第一。 */
  getProviders(): string[];
  /** 配置与预设里**已知**的模型;不给 providerId 就是全部 provider 的。 */
  getModels(providerId?: string): ExtensionModelEntry[];
  find(providerId: string, modelId: string): ExtensionModelEntry | undefined;
  /** models.dev 目录里的能力(思考档位 / 窗口 / 输出上限);库里没有为 undefined。 */
  capabilities(providerId: string, modelId: string): Promise<ModelCapabilities | undefined>;
  /** 在线探测各 provider 的模型列表(与 `/models` 同一条路)。 */
  probe(): Promise<ProviderModels[]>;
}

export interface ExtensionCommand {
  description: string;
  argumentHint?: string;
  /** 选择器框标题;缺省用 `/name`。 */
  selectorTitle?: string;
  /**
   * 取值选择器:给了它,命令在菜单上回车会先让用户选,选中的 value 作为
   * `args` 再调 handler。每次打开现取——档位要标出当前生效的那个,分支
   * 列表要跑 git,静态快照会过期。
   *
   * `path` 是**已经选过的层**(第一层为空数组)。返回项标了 `expands` 就
   * 会带着 `[...path, value]` 再问一次,层数不限;最终提交给 handler 的
   * `args` 是各层 value 以空格连接——所以 `/review` 的 handler 收到的仍是
   * `base main` 这种它本来就认识的字符串,选择器只是它的一种输入方式。
   * 某一层返回空表时客户端提交 `/name <path...>`,由 handler 自己解释
   * "这一层没有可选项"(是没有分支,还是根本不是 git 仓库)。
   */
  options?: (path: string[]) => ExtensionCommandOption[] | Promise<ExtensionCommandOption[]>;
  /**
   * 处理器。它是**即时 RPC**(不是 deferred):要发起一轮就 `followUp` /
   * `void run(...)`,不要 await 一整轮——挂在 HTTP 请求上会撞各层超时;
   * 忙不忙由扩展自己判(`isRunning`),客户端不替它拦——`/goal clear` 正是
   * 循环跑着的时候才要用的。
   *
   * 收 args 与 ctx。曾经还带一个 `{ raw }`(用户敲的原文)做 display 用,但
   * 没有一个扩展读它,而它要一路穿过 wire 字段与两个前端的构造点;真有扩展
   * 要用户的字面文本时再加回来。
   */
  handler: (args: string, ctx: ExtensionContext) => void | Promise<void>;
}

/** 扩展声明的命令行 flag(Pi 的 registerFlag):`mojocode -X name[=value]`。 */
export interface ExtensionFlagOptions {
  description: string;
  type: 'boolean' | 'string';
  default?: string | boolean;
}

/** 扩展之间的事件总线的面(每个扩展拿到的是记录了自己订阅的门面,`/reload` 时好退订)。 */
export interface ExtensionEventBus {
  on(type: string, handler: (data: unknown) => void): () => void;
  emit(type: string, data?: unknown): void;
}

/**
 * 扩展之间的事件总线(Pi 的 `pi.events`):与 AgentEvent 的 bus 无关,类型由
 * 扩展自己约定。emit 同步,处理器抛错不影响其他处理器。
 */
export class ExtensionEvents implements ExtensionEventBus {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  on(type: string, handler: (data: unknown) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  emit(type: string, data?: unknown): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) {
      try {
        handler(data);
      } catch {
        // 一个扩展的处理器出错不影响其他扩展。
      }
    }
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExtensionAPI {
  readonly id: string;
  /** 工作区根目录(绝对路径)。 */
  readonly root: string;
  /** 注册钩子(core/hooks.ts),返回注销函数。 */
  on: HookRegistry['on'];
  /** 只读订阅 bus 的事实流(step-end 记账之类)。 */
  onEvent(handler: (event: AgentEvent) => void): () => void;
  /** 扩展之间的事件总线(与 AgentEvent 的 bus 无关)。 */
  readonly events: ExtensionEventBus;
  registerCommand(name: string, command: ExtensionCommand): void;
  /** 已注册的命令名(内置扩展与磁盘扩展的都算)。 */
  getCommands(): string[];
  /**
   * 全局快捷键(TUI 下,没有覆盖层打开时)。`key` 形如 `ctrl+g` / `meta+shift+k`,
   * 见 normalizeShortcut;必须带 ctrl 或 meta。TUI 自己占着的
   * `RESERVED_SHORTCUTS`(ctrl+c / t / o / r)**注册即抛错**——让扩展作者当场
   * 知道,而不是等用户按下去发现没反应。返回注销函数。
   */
  registerShortcut(key: string, options: ExtensionShortcutOptions): () => void;
  /**
   * 注册(或替换)一个模型可调用的工具。主 agent 的工具集是**就地改键**的
   * ——它与运行中的 Agent 共享引用,下一次开流生效;子 agent 的工具集每次
   * 现建,注册即刻生效。名字冲突时后注册的赢,内置工具不可覆盖。
   *
   * 两种形状:`(name, factory, meta?)` 是 mojocode 的——工厂按 ToolScope
   * 决定给不给;`(definition)` 是 Pi 的——JSON Schema 参数 + Pi 签名的
   * execute,由宿主适配。
   */
  registerTool(name: string, factory: ExtensionToolFactory, meta?: ExtensionToolMeta): void;
  registerTool(definition: ExtensionToolDefinition): void;
  unregisterTool(name: string): void;
  /** 主 agent 工具集里的全部工具名(内置 + 扩展,含被 setActiveTools 停用的)。 */
  getAllTools(): string[];
  /** 当前会交给模型的工具名。 */
  getActiveTools(): string[];
  /**
   * 只把这些工具交给模型(主 agent 与子 agent 都按此过滤);其余仍注册着、
   * 随时可以恢复。传 undefined 恢复全部。
   */
  setActiveTools(names: string[] | undefined): void;
  /** 声明一个命令行 flag(`mojocode -X name[=value]`);值用 getFlag 读。 */
  registerFlag(name: string, options: ExtensionFlagOptions): void;
  /** 读 flag 的值:命令行给了按声明的类型解析,没给用 default。未声明的返回 undefined。 */
  getFlag(name: string): string | boolean | undefined;
  /** 状态行;undefined 清除。 */
  setStatus(text: string | undefined, options?: { since?: number }): void;
  /**
   * 发布一份**结构化状态**给客户端(TUI / GUI):它随 `StateSnapshot` 过线,
   * 客户端从 `extensionState[key]` 同步读,变化经 `extensionsChanged` 通知。
   * `undefined` 清除该键。
   *
   * 与另外两个「对外说话」的成员分工,别混:
   * - `setStatus` 是**一行给人看的文字**,客户端原样贴在输入框上方,不解释;
   * - `setState` 是**数据**,客户端有专门的组件按 key 渲染(todo 清单就是这样);
   * - `publishRuntime` **不过线**,只给宿主进程内的功能(目前只有 `/doctor`)。
   *
   * 值必须可 JSON 序列化,且要小——它随每一帧快照过线,进 `snapshotKey` 的
   * 变化检测。大块内容(技能正文、工具输出)永远走别的通道。
   */
  setState(key: string, value: unknown): void;
  /** 用户可见的一条提示(时间线 notice)。 */
  notify(level: 'info' | 'warn', message: string): void;
  /** 向用户提问(select / confirm / input),见 ExtensionUI。 */
  readonly ui: ExtensionUI;
  /** 此刻有没有前端在看。 */
  readonly hasUI: boolean;
  /** 处理器收到的那个 ctx,给 setup 里就想用的代码。 */
  readonly ctx: ExtensionContext;
  /** 同 ctx.mode。 */
  readonly mode: 'tui' | 'print';
  /** 同 ctx 的四个会话控制成员。 */
  waitForIdle(): Promise<void>;
  newSession(): Promise<void>;
  fork(): Promise<{ id: string }>;
  switchSession(idOrPrefix: string): Promise<void>;
  /**
   * 把一份会话内的运行时快照挂给宿主。目前唯一的消费方是 `/doctor`:它对
   * 「会话里已经拉起来的子进程」有则采信、不再自己拉一份(LSP 的语言服务器、
   * MCP 的 stdio server 都是这个形状)。传的是 getter,读时现取。
   *
   * key 由扩展与宿主约定(宿主按 key 断言类型),值绝不过线——它描述的是
   * 会话进程里的活物,序列化给客户端没有意义。
   */
  publishRuntime(key: string, get: () => unknown): void;
  /**
   * 放一条带自定义类型的消息进对话(Pi 的 sendMessage):`triggerTurn` 作为新
   * 一轮开跑;否则运行中注入为引导、空闲时直接并入历史不开轮。时间线按
   * `registerMessageRenderer(customType)` 的画法画,没注册就画 display / content。
   */
  sendMessage(message: CustomMessageInfo, options?: { triggerTurn?: boolean }): Promise<void>;
  /** 自定义消息的画法(Pi 的 registerMessageRenderer);返回 undefined 用缺省。 */
  registerMessageRenderer(customType: string, renderer: MessageRenderer): void;
  /** 发起一整轮(链条),与 Agent.run 同语义:运行中退化为轮内引导。 */
  run(text: string, options?: ExtensionRunOptions): Promise<void>;
  /** 轮后续跑:当前链条收尾后作为新一轮开跑;空闲时立即开跑。 */
  followUp(text: string, options?: ExtensionRunOptions): void;
  isRunning(): boolean;
  abort(): void;
  /** 模型历史(压缩后是摘要 + 尾巴)。 */
  history(): ModelMessage[];
  /** 手动压缩历史(`/compact` 同一条路);并发调用共享同一次。 */
  compact(): Promise<void>;
  /** 上下文占用:已用 / 窗口 / 百分比,与底栏计量条同源。 */
  getContextUsage(): { used: number; window: number; percent: number };
  /** 会话记录里追加一条自定义记录(kind custom);随会话分叉、随 /resume 读回。 */
  appendEntry(type: string, data: unknown): Promise<void>;
  /** 当前会话的自定义记录(写入顺序)。 */
  entries(type: string): SessionCustomRecord[];
  /** 会话标题(会话列表里那一行)。 */
  getSessionName(): string;
  setSessionName(name: string): Promise<void>;
  /** 会话配置,按引用:/think 之类的就地修改现读现得。 */
  readonly config: Config;
  /** 当前 provider 的模型;给 modelId 用同一 provider 换个模型(评估器、便宜模型)。 */
  model(modelId?: string): LanguageModel;
  /** 当前 provider 与模型 id。 */
  getModel(): { provider: string; model: string };
  /**
   * 切换模型(与 `/models` 同一条路):只给 model 换同 provider 的模型,给了
   * provider 就切 provider(不给 model 时回落到它的默认模型)。会触发
   * `model_select` 钩子。
   */
  setModel(change: { provider?: string; model?: string }): Promise<void>;
  getThinkingLevel(): ReasoningEffort;
  /** 与 `/think` 同一条路;触发 `thinking_level_select`。 */
  setThinkingLevel(level: ReasoningEffort): Promise<void>;
  /** 跑一个外部命令(不经 shell,不抛非零退出码:看 exitCode)。cwd 缺省工作区根。 */
  exec(
    command: string,
    args: readonly string[],
    options?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> },
  ): Promise<ExecResult>;
}

export interface Extension {
  /** 稳定 id:状态行按它去重,日志/提示里点名它,`disabledExtensions` 按它跳过。 */
  id: string;
  /**
   * 装配。一方扩展是同步的;磁盘扩展(`~/.mojocode/extensions/*.ts`、包)
   * 可以是 async——bootstrap 按顺序逐个 await,失败变成一条 startup notice,
   * 绝不拖垮会话。
   */
  setup(api: ExtensionAPI): void | Promise<void>;
}

/**
 * 磁盘扩展模块的导出形状(Pi 式):`export default (api) => { … }`。也接受
 * `export default { id?, setup }`——id 缺省从文件名推(`foo.ts` → `foo`,
 * `foo/index.ts` → `foo`,包里的再冠以 `<包名>/`)。见 extensions/loader.ts。
 */
export type ExtensionModuleExport = ((api: ExtensionAPI) => void | Promise<void>) | Partial<Extension>;
