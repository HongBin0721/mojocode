import type { ModelMessage, ToolSet } from 'ai';
import { Agent } from '../agent/loop.js';
import { BUILTIN_EXTENSIONS } from '../extensions/index.js';
import { discoverExtensions, loadExtension } from '../extensions/loader.js';
import { resolvePackages } from '../extensions/packages.js';
import { LSP_RUNTIME_KEY } from '../extensions/lsp/index.js';
import { MCP_RUNTIME_KEY } from '../extensions/mcp/index.js';
import {
  ExtensionEvents,
  type ExtensionAPI,
  type ExtensionCommand,
  type ExtensionCommandInfo,
  type ExtensionContext,
  type ExtensionFlagOptions,
  type ExtensionStatusEntry,
  type ExtensionCommandOption,
  type ExtensionToolDefinition,
  type ExtensionToolFactory,
  type ExtensionToolMeta,
  type ExtensionSurface,
  type ExtensionUI,
  type MessageRenderer,
  type ToolRenderers,
  type ToolScope,
  type UiAnswer,
  type UiRequest,
} from '../core/extension.js';
import type {
  ComponentHost,
  ExtensionComponent,
  UiCustomRequest,
  UiHost,
  UiSurfaces,
} from '../core/extension-types.js';
import { normalizeShortcut, RESERVED_SHORTCUTS } from '../core/extension-types.js';
import type { ExtensionShortcutOptions } from '../core/extension.js';
import path from 'node:path';
import { adaptToolDefinition } from '../extensions/tool-adapter.js';
import { execa } from 'execa';
import { buildSystemPrompt, gatherEnvironment, type EnvironmentInfo } from '../agent/prompt.js';
import { resolveProvider, type LoadedConfig, type ResolvedProvider } from '../config/load.js';
import { imagesDir } from '../config/paths.js';
import { providerModelIsVision, resolveVisionModelId } from '../config/providers.js';
import { createViewImageTool } from '../tools/view-image.js';
import type { Config, ReasoningEffort } from '../config/schema.js';
import { runDoctor, type DoctorReport } from './doctor.js';
import { EventBus } from '../core/events.js';
import { errorMessage } from '../core/errors.js';
import { HookRegistry } from '../core/hooks.js';
import { createModel, listProviderModels, type ProviderModels } from '../model/registry.js';
import { capabilitiesFor, createCatalogSource, type ModelCapabilities } from '../model/catalog.js';
import { effectiveEfforts } from '../model/reasoning.js';
import type { McpStatus } from '../mcp/client.js';
import type { LspRuntimeStatus } from '../lsp/manager.js';
import { createBuiltinTools } from '../tools/index.js';
import {
  createTaskTool,
  runTaskSubagent,
  EXPLORE_PROMPT,
  SUBAGENT_PROMPT,
  type TaskMode,
  type TaskToolDeps,
} from '../tools/task.js';
import { SessionStore } from '../session/store.js';
import { t } from '../i18n/index.js';
import fs from 'node:fs/promises';
import { SkillManager } from '../skills/manager.js';
import { createSkillTool } from '../skills/tool.js';
import { readSkillBody, type SkillCommandInfo } from '../skills/discovery.js';
import { substituteArgs } from '../skills/substitute.js';
import { wrapSkillPrompt } from '../skills/invocation.js';
import { collectReviewSummary } from '../agent/review.js';
import {
  buildSimplifyApplyPrompt,
  parseSimplifyArg,
  runAxisReviews,
  type SimplifyStartResult,
} from '../agent/simplify.js';

export interface Session {
  root: string;
  config: Config;
  provider: ResolvedProvider;
  env: EnvironmentInfo;
  agent: Agent;
  bus: EventBus;
  /**
   * 扩展钩子注册表(core/hooks.ts):功能从核心搬出去成为扩展时挂在这里——
   * 否决工具、改写结果、改系统提示词、轮后续跑。与主 agent 和子 agent 共享。
   */
  hooks: HookRegistry;
  /**
   * 装配期产生的、必须让用户看到的提示(磁盘扩展加载失败之类)。
   *
   * 为什么不在 bootstrap 里直接 `bus.emit`:那一刻**还没有任何渲染层订阅**
   * ——serve 在 `await bootstrap()` 返回之后才 `bus.on`,TUI 在 App 挂载时才
   * 订阅,headless 同理,而 EventBus 没有重放。emit 出去就是掉在地上。所以
   * 攒起来,由各消费方在订阅之后自己取:serve 在**新客户端接上 SSE 时**补发
   * (刚连上的 client 得知道它连上之前发生过什么),headless 在 `bus.on`
   * 之后立刻发。
   */
  startupNotices: ReadonlyArray<{ level: 'warn' | 'info'; message: string }>;
  store: SessionStore;
  /** 丢弃当前对话,换一个全新的 SessionStore 从头记录(`/new`、`/clear`)。 */
  newSession: () => Promise<SessionStore>;
  /**
   * TUI 内切换到另一个已存会话(`/resume`):解析前缀、打开、换 store、
   * 恢复历史与状态,并尽力切到会话记录的 provider/model。provider 切换
   * 失败会抛出,但此时历史已经载入——调用方据此提示"已恢复但没换模型"。
   */
  resumeSession: (idOrPrefix: string) => Promise<SessionStore>;
  /**
   * 把当前对话分叉进一个全新的会话 id(`/fork`):历史、状态、时间线原样
   * 延续,只是从此写入新文件,源会话停在分叉点不再被写。
   */
  forkSession: () => Promise<SessionStore>;
  /**
   * 会话中途切换模型和/或 provider;返回新解析的 provider。apiKey 只在
   * "TUI 就地输入了新 key"的切换里出现,由实现并入配置后再解析。
   */
  switch: (change: { provider?: string; model?: string; apiKey?: string }) => ResolvedProvider;
  /**
   * 调整当前 provider 的思考档位(`/think`)。收进 Session 契约而不是让 UI
   * 直接改字段:扩展的 setThinkingLevel 与 /think 走同一条路,钩子才发得出。
   */
  setReasoningEffort: (level: ReasoningEffort) => void;
  /**
   * 拉取**所有已配置厂商**的模型列表(`/models` 分组选择器):并发探测,
   * 单组失败不抛错、就地带回原因。
   */
  listProviderModels: () => Promise<ProviderModels[]>;
  /** 逐模型能力(models.dev 目录),见 src/model/catalog.ts。 */
  modelCapabilities: (providerId: string, modelId: string) => Promise<ModelCapabilities | undefined>;
  /**
   * 会话内体检(`/doctor`):读会话此刻的配置、采信已连上的 MCP 状态、
   * 复用已拉起的 LSP——收进契约后 TUI 不必再摸 session.lsp / mcpStatuses。
   */
  doctor: (options: { offline: boolean }) => Promise<DoctorReport>;
  /**
   * 重新收集环境信息并重建系统提示词,让刚写入的 AGENTS.md 不用重启就
   * 生效(`/init` 完成后调用)。
   */
  refreshEnvironment: () => Promise<void>;
  /** user-invocable 技能的投影(命令菜单/StateSnapshot 用),同步读取。 */
  readonly skills: SkillCommandInfo[];
  /** 技能列表实质变化时通知(serve 据此推快照、TUI 刷菜单)。返回退订函数。 */
  skillsChanged: (listener: () => void) => () => void;
  /** 强制重扫技能目录(`/skills`),返回最新投影。 */
  refreshSkills: () => Promise<SkillCommandInfo[]>;
  /**
   * 以用户身份调用技能(`/技能名`、headless `-p`、远程 RPC 共用):激活
   * (扩根 + allowed-tools 确认)→ 展开正文 → 跑一整轮。display 是用户敲的
   * 原文,进时间线;缺省按 name/args 重组。
   */
  runSkill: (name: string, args: string, options?: { display?: string }) => Promise<void>;
  /** 扩展注册的斜杠命令投影(菜单用),同步读取。 */
  readonly extensionCommands: ExtensionCommandInfo[];
  /** 扩展贴在输入框上方的状态行,同步读取。 */
  readonly extensionStatus: ExtensionStatusEntry[];
  /** 扩展发布的结构化状态(key → 值,如 todo 清单),同步读取。 */
  readonly extensionState: Record<string, unknown>;
  /** 取一条扩展命令的选择器取值。每次现取:档位要标当前值,分支列表要跑 git。 */
  commandOptions: (name: string, path?: string[]) => Promise<ExtensionCommandOption[]>;
  /** 命令表或状态行变化时通知(菜单/状态行据此重算)。返回退订函数。 */
  extensionsChanged: (listener: () => void) => () => void;
  /**
   * 执行一条扩展命令。**即时**调用:处理器要发起一轮就 followUp,不 await
   * 整轮(见 ExtensionCommand.handler)。未知命令抛错。
   */
  runCommand: (name: string, args: string) => Promise<void>;
  /**
   * 扩展向用户提的、尚未回答的问题(`ctx.ui.select / confirm / input`)。TUI
   * 把第一条画成提示框;变化经 extensionsChanged 通知。
   */
  readonly uiRequests: UiRequest[];
  /** 回答一个 ui 请求(未知 id 静默忽略——已经答过或已取消)。 */
  answerUi: (id: string, answer: UiAnswer) => void;
  /**
   * TUI 挂上会话:有没有人在看、读写输入框草稿(见 UiHost)。App 挂载时调,
   * 卸载时传 undefined;headless 从不调——扩展的提问立即按缺省兑现。
   */
  attachUi: (host: UiHost | undefined) => void;
  /** TUI 按到带修饰键的组合时问一声:有扩展认领就跑它的处理器并返回 true。 */
  runShortcut: (key: string) => boolean;
  /** `ui.custom` 挂出来、还没 done 的组件(TUI 画第一条,独占键盘)。 */
  readonly uiCustoms: UiCustomRequest[];
  /** 组件 done 之后 TUI 调它把 value 交回扩展;未知 id 静默。 */
  resolveCustom: (id: string, value: unknown) => void;
  /** 扩展占用的界面区域(widget / header / footer / title),变化经 extensionsChanged。 */
  readonly uiSurfaces: UiSurfaces;
  /** 工具在时间线里的自定义画法(registerTool 的 renderCall / renderResult),按工具名。 */
  readonly toolRenderers: ReadonlyMap<string, ToolRenderers>;
  /** 自定义消息的画法(registerMessageRenderer),按 customType。 */
  readonly messageRenderers: ReadonlyMap<string, MessageRenderer>;
  /** `/reload`:卸载全部磁盘扩展、换一代模块缓存、重新装载。一方扩展不动。 */
  reloadExtensions: () => Promise<{ loaded: string[]; failed: string[] }>;
  /**
   * 以用户身份跑一轮代码清理(`/simplify`,对齐 Claude Code):解析目标 →
   * 复用 review.ts 的收集器 → 组稿清理提示词交给 agent.run,模型在这一轮里
   * 直接应用修复(编辑工作区、保持未提交)。失败同样以 reason 代码返回。
   */
  startSimplify: (targetArg: string, options?: { display?: string }) => Promise<SimplifyStartResult>;
  dispose: () => Promise<void>;
}

export interface BootstrapOptions {
  root: string;
  loaded: LoadedConfig;
  /** 恢复该会话的历史,而不是从头开始。 */
  resume?: SessionStore;
  /** 配合 resume:历史与状态载入,但写入一个全新的会话 id(`--fork-session`)。 */
  fork?: boolean;
  /**
   * 不加载这几个一方扩展(按 id)。`--no-mcp` 走的就是这条路——功能搬成扩展
   * 之后,「关掉一个功能」天然就是「不加载那个扩展」,不必再给每个功能配一个
   * 专属开关。
   */
  disabledExtensions?: string[];
  /** 命令行 `-e <path>` 指定的磁盘扩展(文件或目录),在目录发现之后装。 */
  extensionPaths?: string[];
  /**
   * 命令行 `-X name[=value]` 给扩展的 flag(Pi 的 registerFlag):不带 `=`
   * 是 true,带了是字符串;扩展按自己声明的类型经 `getFlag` 读。
   */
  extensionFlags?: Record<string, string | boolean>;
  /** `tui`(默认)或 `print`(`-p`),进 ctx.mode。 */
  mode?: 'tui' | 'print';
}

/** explore 子 agent 的只读白名单(内置工具);扩展工具由各自的工厂决定。 */
const EXPLORE_TOOLS = new Set(['read', 'glob', 'grep', 'view_image', 'skill']);

/** 扩展不得覆盖的内置工具名(含 task/skill 这两个由 bootstrap 装配的)。 */
const BUILTIN_TOOL_NAMES = new Set([
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'bash',
  'view_image',
  'task',
  'skill',
]);

export async function bootstrap(options: BootstrapOptions): Promise<Session> {
  const { root, loaded } = options;
  const config = loaded.config;
  let provider = loaded.provider;

  const bus = new EventBus();
  // 扩展钩子(core/hooks.ts)。处理器出错只上报成 notice,绝不冒泡到循环里。
  // 不传兜底 ctx:每条注册自带自己那份(`api.on` 传 extCtx),只有 bootstrap
  // 自己注册的那几个内部钩子用注册表的空实现,它们本来就不读 ctx。
  const hooks = new HookRegistry(({ hook, error }) => {
    bus.emit({
      type: 'notice',
      level: 'warn',
      message: t('notice.hookFailed', { hook, message: error.message }),
    });
  });

  // ---- 扩展向用户提问(ctx.ui):请求记进 uiRequests,答案经 answerUi 回来 ----
  //
  // 「有没有前端在看」由宿主注入(attachUi):TUI 的 App 挂载时给恒真,
  // headless 从不注入。没人看时立即按缺省兑现——扩展的 select 拿到
  // undefined、confirm 拿到 false,与用户按 esc 是同一个结局,扩展不必分辨。
  let uiHost: UiHost | undefined;
  const uiAvailable = (): boolean => uiHost?.available() ?? false;
  let uiCounter = 0;
  const uiPending = new Map<
    string,
    { request: UiRequest; resolve: (answer: UiAnswer) => void; owner?: string }
  >();
  type UiRequestSpec = UiRequest extends infer R ? (R extends UiRequest ? Omit<R, 'id'> : never) : never;
  const askUi = (request: UiRequestSpec, owner?: string): Promise<UiAnswer> => {
    if (!uiAvailable()) return Promise.resolve(undefined);
    const id = `ui-${++uiCounter}`;
    const full = { ...request, id } as UiRequest;
    return new Promise<UiAnswer>((resolve) => {
      uiPending.set(id, { request: full, resolve, ...(owner ? { owner } : {}) });
      // 先通知订阅者(TUI 据 uiRequests 画框),再上总线(headless --json 的
      // 事件流与扩展的 onEvent 看得到)。
      extensionsChanged();
      bus.emit({ type: 'ui-request', request: full });
    });
  };
  const answerUi = (id: string, answer: UiAnswer): void => {
    const entry = uiPending.get(id);
    if (!entry) return; // 已经答过,或已被取消
    uiPending.delete(id);
    entry.resolve(answer);
    bus.emit({ type: 'ui-resolved', id });
    extensionsChanged();
  };
  // ---- 渲染区域与自定义组件(Pi 的 ctx.ui.custom / setWidget …) ----
  //
  // 与提问同一套形状:核心只存「待画的东西」并通知订阅者,TUI 读出来画;
  // 没有前端时 custom 立即以 undefined 兑现、区域设置照记不误(挂上 TUI 时
  // 就能画出来,headless 永远不画)。
  let uiCustomCounter = 0;
  const uiCustoms = new Map<
    string,
    { request: UiCustomRequest; resolve: (value: unknown) => void; owner?: string }
  >();
  const resolveCustom = (id: string, value: unknown): void => {
    const entry = uiCustoms.get(id);
    if (!entry) return;
    uiCustoms.delete(id);
    entry.resolve(value);
    extensionsChanged();
  };
  /**
   * 界面区域与两张画法表都是**换引用**而不是就地改:TUI 侧靠身份判断
   * "有没有变"(Solid 信号的默认相等是 `===`)。就地改会让读取方永远看到
   * 同一个对象——除非每次读都复制一份,而那又反过来让每次读都"变了",于是
   * `extensionsChanged` 每跳一次(todo 每次工具调用都跳)就重算整条时间线的
   * 自定义画法。换引用两头都对:内容没变身份就没变。
   */
  let uiSurfaces: UiSurfaces = { widgets: [] };
  const setSurface = (slot: 'header' | 'footer', surface: ExtensionSurface | undefined): void => {
    if (surface === undefined) {
      if (uiSurfaces[slot] === undefined) return;
      const next = { ...uiSurfaces };
      delete next[slot];
      uiSurfaces = next;
    } else {
      if (uiSurfaces[slot] === surface) return;
      uiSurfaces = { ...uiSurfaces, [slot]: surface };
    }
    extensionsChanged();
  };
  /** 工具的自定义画法,registerTool 时登记、unregister 时删。 */
  let toolRenderers: ReadonlyMap<string, ToolRenderers> = new Map();
  /** 自定义消息的画法(registerMessageRenderer),按 customType。 */
  let messageRenderers: ReadonlyMap<string, MessageRenderer> = new Map();
  const setRenderer = <T,>(
    table: ReadonlyMap<string, T>,
    key: string,
    value: T | undefined,
  ): ReadonlyMap<string, T> => {
    if (value === undefined) {
      if (!table.has(key)) return table;
      const next = new Map(table);
      next.delete(key);
      return next;
    }
    return new Map(table).set(key, value);
  };

  /** 界面区域的三个原语(下面的 ctx 工厂在它们外面加"记在谁名下")。 */
  const setWidgetImpl = (key: string, surface: ExtensionSurface | undefined): void => {
    const index = uiSurfaces.widgets.findIndex((w) => w.key === key);
    if (surface === undefined) {
      if (index === -1) return;
      uiSurfaces = { ...uiSurfaces, widgets: uiSurfaces.widgets.filter((w) => w.key !== key) };
    } else if (index === -1) {
      uiSurfaces = { ...uiSurfaces, widgets: [...uiSurfaces.widgets, { key, surface }] };
    } else {
      if (uiSurfaces.widgets[index]!.surface === surface) return;
      const widgets = [...uiSurfaces.widgets];
      widgets[index] = { key, surface };
      uiSurfaces = { ...uiSurfaces, widgets };
    }
    extensionsChanged();
  };
  const setTitleImpl = (title: string | undefined): void => {
    if (uiSurfaces.title === title) return;
    if (title === undefined) {
      const next = { ...uiSurfaces };
      delete next.title;
      uiSurfaces = next;
    } else {
      uiSurfaces = { ...uiSurfaces, title };
    }
    extensionsChanged();
  };

  /**
   * 空闲 = 没有链条在跑、也没有压缩在跑。`isIdle()` 与 `waitForIdle()` 必须
   * 是同一个判据——两者曾经一个只看 isRunning、另一个连压缩也等,于是
   * `if (ctx.isIdle()) …` 会在压缩进行中放行,而那正是消息会被覆盖的窗口。
   * 真正的等待逻辑在 Agent.whenIdle(见那边关于"不能靠 bus 事件"的注释)。
   */
  const isIdle = (): boolean => !agent.isRunning && !agent.isCompacting;
  const waitForIdle = (): Promise<void> => agent.whenIdle();

  /**
   * 一个扩展的 ctx 与 ui(Pi 同形)。**每个扩展一份,由这一个工厂建**:
   *
   *  - `hasUI` 必须是**真 getter**。曾经的写法是建一份全局 ctx 再
   *    `{ ...extensionContext, ui }` 覆盖 ui——展开会在建 API 的那一刻
   *    (bootstrap 期、attachUi 之前)把 getter 求值成 false 钉死,扩展从此
   *    永远以为没有界面。工厂里逐字段构造,这个坑结构上不存在。
   *  - 提问与界面区域要**记在谁名下**:`/reload` 卸载时才撤得掉(挂着的框
   *    要按"没答"兑现,widget 要收回)。`undoOnce` 由调用方给。
   *
   * 成员按引用晚绑定:agent / provider / 会话操作在下方才就绪。
   */
  const createExtensionContext = (
    owner: string,
    undoOnce: (key: string, undo: () => void) => void,
  ): ExtensionContext => {
    const ui: ExtensionUI = {
      custom: <T,>(
        factory: (host: ComponentHost, done: (value: T) => void) => ExtensionComponent,
      ): Promise<T | undefined> => {
        if (!uiAvailable()) return Promise.resolve(undefined);
        const id = `custom-${++uiCustomCounter}`;
        return new Promise<T | undefined>((resolve) => {
          uiCustoms.set(id, {
            request: { id, factory: factory as UiCustomRequest['factory'] },
            resolve: (value) => resolve(value as T | undefined),
            owner,
          });
          extensionsChanged();
        });
      },
      setWidget: (key, surface) => {
        undoOnce(`widget:${key}`, () => setWidgetImpl(key, undefined));
        setWidgetImpl(key, surface);
      },
      setHeader: (surface) => {
        undoOnce('header', () => setSurface('header', undefined));
        setSurface('header', surface);
      },
      setFooter: (surface) => {
        undoOnce('footer', () => setSurface('footer', undefined));
        setSurface('footer', surface);
      },
      setTitle: (title) => {
        undoOnce('title', () => setTitleImpl(undefined));
        setTitleImpl(title);
      },
      getEditorText: () => uiHost?.getEditorText?.() ?? '',
      setEditorText: (text) => uiHost?.setEditorText?.(text),
      select: async (title, items) => {
        const answer = await askUi({ kind: 'select', title, items }, owner);
        // 答案必须是列表里的一项:提示框只会发这些,但 answerUi 谁都能调。
        return typeof answer === 'string' && items.includes(answer) ? answer : undefined;
      },
      confirm: async (title, message) =>
        (await askUi({ kind: 'confirm', title, message }, owner)) === true,
      input: async (title, placeholder) => {
        const answer = await askUi(
          { kind: 'input', title, ...(placeholder !== undefined ? { placeholder } : {}) },
          owner,
        );
        return typeof answer === 'string' ? answer : undefined;
      },
      notify: (message, level = 'info') => bus.emit({ type: 'notice', level, message }),
    };
    return {
      cwd: root,
      get hasUI() {
        return uiAvailable();
      },
      mode: options.mode ?? 'tui',
      isIdle,
      abort: () => agent.abort(),
      waitForIdle,
      newSession: async () => {
        await newSessionImpl();
      },
      fork: async () => ({ id: (await forkSessionImpl()).id }),
      switchSession: async (idOrPrefix) => {
        await resumeSessionImpl(idOrPrefix);
      },
      model: (modelId) => createModel(modelId ? { ...provider, model: modelId } : provider),
      config,
      ui,
    };
  };
  /** 扩展注册的快捷键(normalizeShortcut 后的键 → 处理器)。 */
  const shortcuts = new Map<
    string,
    ExtensionShortcutOptions & { owner: string; ctx: ExtensionContext }
  >();
  /** 扩展之间的事件总线(与 AgentEvent 的 bus 无关),所有扩展共用一份。 */
  const extensionEvents = new ExtensionEvents();
  // models.dev 能力目录:懒加载 + 磁盘缓存(首个 modelCapabilities 调用才拉取)。
  const catalogSource = createCatalogSource();

  /**
   * 技能的会话态:pendingUserSkills 是本轮用户斜杠点名的技能(skill 工具
   * 据此放行 disable-model-invocation)。
   */
  const skillActivation = {
    pendingUserSkills: new Set<string>(),
  };
  /** `/new`、`/resume` 时清空:它是对话级状态,不跨对话漂移。 */
  const resetSkillActivation = (): void => {
    skillActivation.pendingUserSkills.clear();
  };

  const toolContext = {
    root,
    bus,
    readFiles: new Set<string>(),
    // 惰性 getter:config 会被 switchProvider 就地修改,现取现算才拿到当下
    // 的值。view_image 的视觉模型:顶层 visionModel 覆盖,缺省回落内置预设。
    visionModel: () => {
      const target = resolveVisionModelId(provider.id, config);
      return target ? createModel({ ...provider, model: target }) : undefined;
    },
  };
  // 粘贴图的落盘目录。提前建好;失败不打扰——降级落盘那一刻的 mkdir 才是
  // 真正的兜底。
  void fs.mkdir(imagesDir(), { recursive: true }).catch(() => {});

  // 扩展包先解析到磁盘:它既可能带扩展也可能带技能,后者要在 SkillManager
  // 建好之前知道目录。配置里记着却找不到的包不是致命错误——提示用户重新
  // install 即可,别的扩展照装。
  const startupNotices: Array<{ level: 'warn' | 'info'; message: string }> = [];
  const resolved = await resolvePackages(config.packages, { root });
  for (const spec of resolved.missing) {
    startupNotices.push({ level: 'warn', message: t('notice.packageMissing', { spec }) });
  }
  const skillManager = new SkillManager({
    root,
    packageDirs: resolved.packages.flatMap((pkg) => pkg.manifest.skills),
  });

  // env 可变:refreshEnvironment(`/init` 写完 AGENTS.md 后)会整体换新。
  // 技能初扫并入同一批:tools 组装(下方)读 skillManager.current() 决定
  // 要不要注册 skill 工具。扫描失败按"没有技能"处理,不拦启动。
  let [env] = await Promise.all([
    gatherEnvironment(root),
    skillManager.list().catch(() => undefined),
  ]);

  /**
   * 扩展注册的工具(name → 工厂,见 ExtensionAPI.registerTool)。主 agent 的
   * `tools` 是**就地改键**的(与运行中的 Agent 共享引用,下一次开流生效);
   * 子 agent 的工具集每次现建,直接从这张表现算。
   */
  const extensionTools = new Map<string, ExtensionToolFactory>();
  /** 扩展工具的自述(promptSnippet / promptGuidelines),宿主拼进系统提示词。 */
  const extensionToolMeta = new Map<string, ExtensionToolMeta>();
  /**
   * setActiveTools 选中的工具名:undefined = 全部。工具本身仍注册着(tools
   * 对象不动),过滤**只在开流边界做一次**——主 agent 与子 agent 都经
   * `AgentOptions.activeTools`,所以这里只需把这个访问器交出去。
   */
  let activeTools: Set<string> | undefined;
  const activeToolsOf = (): ReadonlySet<string> | undefined => activeTools;
  const isToolActive = (name: string): boolean => !activeTools || activeTools.has(name);
  const materializeExtensionTools = (scope: ToolScope): ToolSet => {
    const out: ToolSet = {};
    for (const [name, factory] of extensionTools) {
      const built = factory(scope);
      if (built) out[name] = built;
    }
    return out;
  };

  /**
   * 子 agent 的工具集:每次现建一份 builtin(共享同一个 toolContext,权限门、
   * readFiles、搜索后端全都同一套)。task 本身不在 builtin 里,递归天然只放
   * 一层;todo 与 exit_plan 现在都是**扩展工具**,「子 agent 不给」由各自的
   * 工厂按 `ToolScope` 自己判,不在这里剔除。现建而非复用 tools:注册与否
   * 取决于当时的运行时状态(搜索后端解析得出来没有、MCP 连上没有)。
   */
  const subagentTools = (mode: TaskMode): ToolSet => {
    // 自己的 readFiles:护栏要保证"改的那个 agent 亲眼看过内容",共享会让
    // 主 agent 凭子 agent 的阅读就能编辑自己从没读过的文件。每次调用现建
    // 一份,连续两个子任务之间也不串。
    const subContext = { ...toolContext, readFiles: new Set<string>() };
    const builtin: ToolSet = {
      ...createBuiltinTools(subContext),
      // 子 agent 的 skill 工具:激活只扩根、不弹确认,fork 退化为内联返回
      // 正文(runFork 不注入),守住"递归只放一层"。
      ...(hasModelSkills() ? { skill: skillToolFor(true) } : {}),
    };
    // explore:纯调研,只留只读工具。skill 留下是安全的:它只返回文本、登记
    // 只读扩根,子 agent 激活不确认,所以永远不会在 explore 里弹出确认框
    // ——这个耦合破了就得把它移出白名单。
    if (mode === 'explore') {
      for (const name of Object.keys(builtin)) {
        if (!EXPLORE_TOOLS.has(name)) delete builtin[name];
      }
    }
    // 扩展工具由工厂按作用域自己决定给不给(MCP 在 explore 里就不给),
    // 所以不参与上面那张内置白名单;每次现建,注册即刻生效。
    // 停用规则不在这里筛:它由 AgentOptions.activeTools 在开流边界统一应用。
    return { ...builtin, ...materializeExtensionTools({ subagent: true, mode }) };
  };

  /** 子 agent 的系统提示词:同一份基座 + 子 agent 约束 + explore 的只读说明。 */
  const subagentSystemPrompt = (mode: TaskMode): string => {
    const base = buildSystemPrompt(
      env,
      { viewImage: viewImageFor(taskProvider()) },
      config.systemPromptAppend,
    );
    const modeNote = mode === 'explore' ? `\n\n${EXPLORE_PROMPT}` : '';
    return `${base}\n\n${SUBAGENT_PROMPT}${modeNote}`;
  };

  /** 子 agent 的 provider:惰性取,taskModel 覆盖模型 id(未配置则原样)。 */
  const taskProvider = (): ResolvedProvider =>
    config.taskModel ? { ...provider, model: config.taskModel } : provider;

  /** task 工具与 skill 工具的 fork 通道共用同一份子代理依赖。 */
  const taskDeps: TaskToolDeps = {
    config,
    activeTools: activeToolsOf,
    bus,
    hooks,
    // 惰性取值:/models、/provider 之后 provider 是新对象,提前建好的模型
    // 会一直打向被换掉的服务端(与 GoalController.evaluatorModel 同理)。
    // model 与 provider 必须取同一份:normalizeError 用 provider.model 组装
    // "模型不存在"的提示,两者不一致时 taskModel 打错字会报到会话模型头上,
    // 指着一个完全正常的 id 让人排查。
    model: () => createModel(taskProvider()),
    provider: taskProvider,
    systemPrompt: subagentSystemPrompt,
    tools: subagentTools,
    // agent/store 在下方才创建;回调要到子任务收尾才被调用,那时早已就绪。
    onTokens: (tokens) => agent.addExternalTokens(tokens),
    // 完整过程随会话落盘(kind: 'task' 记录,恢复回放不读、旧版本安全跳过),
    // 排查"子任务为什么给了错结论"的唯一入口。尽力而为,失败不打扰。
    onTranscript: (transcript) => {
      void store.saveTask(transcript).catch(() => {});
    },
  };

  const hasModelSkills = (): boolean =>
    skillManager.current().skills.some((skill) => !skill.disableModelInvocation);

  /** skill 工具:主 agent 带 runFork(context: fork 走子代理通道);子 agent 不带。 */
  const skillToolFor = (subagent: boolean) =>
    createSkillTool({
      manager: skillManager,
      ...(subagent
        ? {}
        : {
            runFork: (opts) =>
              runTaskSubagent(taskDeps, {
                description: `Skill: ${opts.meta.name}`,
                prompt: opts.prompt,
                mode: 'general',
                toolCallId: opts.toolCallId,
                abortSignal: opts.abortSignal,
              }),
          }),
      pendingUserSkills: skillActivation.pendingUserSkills,
    });

  const tools = {
    ...createBuiltinTools(toolContext),
    task: createTaskTool(taskDeps),
    // 一个 model-invocable 技能都没有时干脆不注册:空列表的工具纯占前缀。
    ...(hasModelSkills() ? { skill: skillToolFor(false) } : {}),
  };
  /**
   * 扩展工具并进主工具集(就地改键,理由见 extensionTools 与 syncSkillTool)。
   * 内置工具不可覆盖:一个装错的扩展不该把 `read` 顶掉。
   */
  const syncExtensionTool = (name: string): void => {
    const factory = extensionTools.get(name);
    if (!factory) {
      delete (tools as ToolSet)[name];
      return;
    }
    const built = factory({ subagent: false });
    if (built) (tools as ToolSet)[name] = built;
    else delete (tools as ToolSet)[name];
  };
  // 系统提示词按注册结果如实陈述——说了不存在的工具,模型就会去调它。
  let viewImageAvailable = 'view_image' in tools;
  /**
   * /provider 切换后同步 view_image 的注册状态(照 syncSkillTool 的原地改键:
   * tools 与运行中的 Agent 共享引用,重建对象它看不见)。web_search 是启动时
   * 的一次性事实(搜索后端不随 provider 切换),view_image 的解析随 provider
   * 变——不同步会让信封和系统提示词指着一个 execute 会抛错的工具(或反之,
   * 视觉模型降级到"读不到"的信封直到重启)。
   */
  const syncViewImageTool = (): void => {
    const want = toolContext.visionModel() !== undefined;
    viewImageAvailable = want;
    if (want) (tools as ToolSet).view_image = createViewImageTool(toolContext);
    else delete (tools as ToolSet).view_image;
  };
  /**
   * view_image 的系统提示词陈述条件:工具已注册,**且**该提示词对应的模型
   * 自己看不了图——视觉主力模型收到的是内联图片,再说"你看不到图"只会
   * 让它对着已经在手上的图去调工具。子代理按 taskProvider() 的模型判定。
   */
  const viewImageFor = (p: ResolvedProvider): boolean =>
    viewImageAvailable && !providerModelIsVision(p, config);

  let skillDigest = skillManager.digest();
  /**
   * 技能的 L1 列表变了就整个换掉 skill 工具(description 是静态串,只能
   * 重建)。必须**原地改 tools 的键**:tools 对象与运行中的 Agent 共享
   * 引用,重建对象它看不见;改键在下一次 stream 生效。
   */
  const syncSkillTool = (): void => {
    const digest = skillManager.digest();
    if (digest === skillDigest) return;
    skillDigest = digest;
    if (hasModelSkills()) (tools as ToolSet).skill = skillToolFor(false);
    else delete (tools as ToolSet).skill;
  };

  // 可变:newSession/resumeSession 会把它换掉,onHistoryChange 始终写当前这个。
  let store: SessionStore;
  if (options.resume && options.fork) {
    // fork:eager 拷贝进新文件,源会话从此不再被写。
    store = await options.resume.fork({ provider: provider.id, model: provider.model });
  } else if (options.resume) {
    store = options.resume;
    // 恢复不切模型(见 resumeOverrides),所以反过来把 meta 对齐到当前模型:
    // 那两个字段只喂会话列表,留着旧值就成了一句不会兑现的话。
    store.setModel(provider.id, provider.model);
  } else {
    store = await SessionStore.create({ root, provider: provider.id, model: provider.model });
  }

  const agent = new Agent({
    model: createModel(provider),
    provider,
    config,
    systemPrompt: buildSystemPrompt(env, { viewImage: viewImageFor(provider) }, config.systemPromptAppend),
    tools,
    bus,
    hooks,
    activeTools: activeToolsOf,
    onHistoryChange: (messages: ModelMessage[]) => {
      void store.save(messages).catch((err: Error) => {
        bus.emit({ type: 'notice', level: 'warn', message: t('notice.sessionSaveFailed', { message: err.message }) });
      });
    },
  });

  // 轮末把本轮真实用量随会话落盘(kind: 'usage',恢复回放不读、旧版本安全
  // 跳过)。缓存命中率与成本核算都靠逐轮数据,而消息流里无从还原。取当下的
  // provider:/models 换过之后统计要记到实际服务的那个模型头上。尽力而为,
  // 失败只静默——统计缺一轮远好过打断一次会话。

  // 工具的流式增量 → tool_execution_update 钩子(只有主 agent 的经主总线)。
  bus.on((event) => {
    if (event.type !== 'tool-output-delta' || !hooks.has('tool_execution_update')) return;
    void hooks.notify('tool_execution_update', { callId: event.callId, chunk: event.chunk, subagent: false });
  });

  bus.on((event) => {
    if (event.type !== 'turn-end') return;
    void store
      .saveUsage({
        provider: provider.id,
        model: provider.model,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cachedInputTokens: event.usage.cachedInputTokens,
      })
      .catch(() => {});
  });

  // ---- 扩展(core/extension.ts):命令表、状态行,以及给每个扩展的 API ----
  const extensionCommands = new Map<
    string,
    { info: ExtensionCommandInfo; command: ExtensionCommand; ctx: ExtensionContext }
  >();
  const extensionStatus = new Map<string, ExtensionStatusEntry>();
  /** 扩展发布给客户端的结构化状态(见 ExtensionAPI.setState),随快照过线。 */
  const extensionState = new Map<string, unknown>();
  const extensionListeners = new Set<() => void>();
  const extensionsChanged = (): void => {
    for (const listener of extensionListeners) listener();
  };
  /**
   * 值没变就不通知。一次 extensionsChanged 会让 TUI 重算命令菜单、状态行与
   * todo 面板;重复发布是常态而非例外:todo 每次工具调用都重发整份清单
   * (哪怕只是把一项从 pending 挪到 in_progress)。
   */
  const sameJson = (a: unknown, b: unknown): boolean =>
    a !== undefined && JSON.stringify(a) === JSON.stringify(b);
  /**
   * 扩展发布的运行时快照(见 ExtensionAPI.publishRuntime)。只在会话进程里
   * 读,不进任何 wire 快照——它描述的是本进程里的活物(已拉起的子进程)。
   */
  const extensionRuntime = new Map<string, () => unknown>();
  /**
   * 读一份扩展发布的运行时快照;getter 可以返回 promise(MCP 的连接收尾)。
   *
   * 返回 `undefined` 有**两种**来路,调用方必须自己分清:没人发布过这个 key
   * (扩展没装),或者发布方此刻确实没东西可报(LSP 还没被任何编辑触发)。
   * 想区分就配 `extensionRuntime.has(key)`——doctor 的 MCP 分节正靠它。
   */
  const runtimeOf = async <T>(key: string): Promise<T | undefined> =>
    (await extensionRuntime.get(key)?.()) as T | undefined;

  /**
   * 扩展声明的命令行 flag(registerFlag)与命令行实际给的值(`-X name[=value]`)。
   * 值按声明的类型解析:boolean 认 `-X name` / `=true` / `=1`,string 原样。
   */
  const flagDecls = new Map<string, ExtensionFlagOptions>();
  const flagValues = options.extensionFlags ?? {};
  const getFlag = (name: string): string | boolean | undefined => {
    const decl = flagDecls.get(name);
    if (!decl) return undefined;
    const raw = flagValues[name];
    if (raw === undefined) return decl.default;
    if (decl.type === 'boolean') return raw === true || raw === 'true' || raw === '1' || raw === '';
    return raw === true ? (typeof decl.default === 'string' ? decl.default : '') : raw;
  };

  /**
   * 扩展工具的自述拼成系统提示词的一节(Pi 的 promptSnippet / promptGuidelines):
   * 只列此刻真在主工具集里、且未被 setActiveTools 停掉的——提示词与实际交给
   * 模型的工具永远一致。第一次有工具带自述时才装这个钩子,没有就零开销。
   */
  const extensionToolPromptSection = (): string | undefined => {
    const lines: string[] = [];
    const guidelines: string[] = [];
    for (const [name, meta] of extensionToolMeta) {
      if (!(name in tools) || !isToolActive(name)) continue;
      if (meta.promptSnippet) lines.push(`- ${name}: ${meta.promptSnippet}`);
      for (const rule of meta.promptGuidelines ?? []) guidelines.push(`- ${rule}`);
    }
    if (lines.length === 0 && guidelines.length === 0) return undefined;
    const sections = ['## Extension tools'];
    if (lines.length > 0) sections.push(lines.join('\n'));
    if (guidelines.length > 0) sections.push(`Guidelines:\n${guidelines.join('\n')}`);
    return sections.join('\n\n');
  };
  let toolPromptHookInstalled = false;
  const ensureToolPromptHook = (): void => {
    if (toolPromptHookInstalled) return;
    toolPromptHookInstalled = true;
    hooks.on('before_agent_start', ({ systemPrompt }) => {
      const section = extensionToolPromptSection();
      return section ? { systemPrompt: `${systemPrompt}\n\n${section}` } : undefined;
    });
  };
  const registerToolImpl = (
    id: string,
    name: string,
    factory: ExtensionToolFactory,
    meta: ExtensionToolMeta | undefined,
  ): void => {
    if (BUILTIN_TOOL_NAMES.has(name)) {
      throw new Error(`Extension "${id}" cannot register the builtin tool "${name}".`);
    }
    extensionTools.set(name, factory);
    if (meta && (meta.promptSnippet || meta.promptGuidelines?.length)) {
      extensionToolMeta.set(name, meta);
      ensureToolPromptHook();
    } else {
      extensionToolMeta.delete(name);
    }
    toolRenderers = setRenderer(
      toolRenderers,
      name,
      meta && (meta.renderCall || meta.renderResult)
        ? {
            ...(meta.renderCall ? { renderCall: meta.renderCall } : {}),
            ...(meta.renderResult ? { renderResult: meta.renderResult } : {}),
          }
        : undefined,
    );
    syncExtensionTool(name);
    extensionsChanged();
  };

  /**
   * 一个扩展注册过的东西,`/reload` 卸载时倒序撤销。
   *
   * **只有一个 `undo` 栈,不是十二个分类字段**:每个注册成员在**注册那一行**
   * 就近把自己的反操作压进来,「加一个 API 成员」与「让它可重载」因此是同一处
   * 编辑。原来按种类分字段的写法要求作者记得在两个相隔三十行的地方各写一笔,
   * 漏一个就多一份幽灵注册——而它确实已经漏了:扩展挂起的提问与 `ui.custom`
   * 组件当时没人记,`/reload` 后屏幕上会留下一个 resolver 已被丢弃的框。
   * `shutdown` 单列:它要先跑、要 await,且是扩展自己的收尾而不是宿主的撤销。
   */
  interface Registrations {
    undo: Array<() => void>;
    shutdown: Array<() => void | Promise<void>>;
  }
  const registrations = new Map<string, Registrations>();
  const unloadExtension = async (id: string): Promise<void> => {
    const reg = registrations.get(id);
    if (!reg) return;
    registrations.delete(id);
    for (const fn of reg.shutdown) {
      try {
        await fn();
      } catch {
        /* 卸载路上的错误不打扰:扩展马上就被换掉了 */
      }
    }
    // 倒序:后注册的先撤,与注册顺序对称(同名工具被后者覆盖时才撤得对)。
    for (const fn of reg.undo.splice(0).reverse()) {
      try {
        fn();
      } catch {
        /* 同上 */
      }
    }
    extensionsChanged();
  };

  const createExtensionApi = (id: string): ExtensionAPI => {
    const reg: Registrations = { undo: [], shutdown: [] };
    registrations.set(id, reg);
    const track = (off: () => void): (() => void) => {
      reg.undo.push(off);
      return off;
    };
    /** 同一把钥匙只压一条撤销(setStatus / setState / setWidget 会被反复调用)。 */
    const undoKeys = new Set<string>();
    const registerUndoOnce = (key: string, undo: () => void): void => {
      if (undoKeys.has(key)) return;
      undoKeys.add(key);
      reg.undo.push(undo);
    };
    // 卸载时把这个扩展挂着的提问与组件按「没答」兑现——等着它们的是已经被
    // 换掉的那份模块,不收尾就永远挂在 await 上,框也留在屏幕上。
    reg.undo.push(() => {
      for (const [pid, entry] of [...uiPending]) if (entry.owner === id) answerUi(pid, undefined);
      for (const [cid, entry] of [...uiCustoms]) if (entry.owner === id) resolveCustom(cid, undefined);
    });
    /** 工具的撤销:名字可能被后装的扩展顶掉,撤之前先确认还是自己那份工厂。 */
    const dropTool = (name: string): void => {
      extensionTools.delete(name);
      extensionToolMeta.delete(name);
      toolRenderers = setRenderer(toolRenderers, name, undefined);
      syncExtensionTool(name);
    };
    const trackTool = (name: string): void => {
      registerUndoOnce(`tool:${name}`, () => dropTool(name));
    };
    /**
     * 这个扩展的 ui 与 ctx:`createExtensionContext` 建的,提问与界面区域
     * 都记在它名下(卸载时才撤得干净)。**它必须一路传到处理器手上**——
     * 钩子、命令、快捷键、Pi 形状工具的 execute 收到的都是这一份。
     */
    const extCtx = createExtensionContext(id, registerUndoOnce);
    const ui = extCtx.ui;
    return {
      id,
      root,
      // 每条注册自带自己的 ctx(见 HookRegistry.on):不必包一层匿名函数换
      // ctx——那既废掉注册表按处理器身份的去重,也在扩展的调用栈里塞一帧。
      on: (name, handler) => {
        if (name === 'session_shutdown') reg.shutdown.push(handler as () => void | Promise<void>);
        return track(hooks.on(name, handler, extCtx));
      },
      onEvent: (handler) => track(bus.on(handler)),
      events: {
        on: (type, handler) => track(extensionEvents.on(type, handler)),
        emit: (type, data) => extensionEvents.emit(type, data),
      },
      ui,
      get hasUI() {
        return uiAvailable();
      },
      ctx: extCtx,
      mode: extCtx.mode,
      waitForIdle: extCtx.waitForIdle,
      newSession: extCtx.newSession,
      fork: extCtx.fork,
      switchSession: extCtx.switchSession,
      getCommands: () => [...extensionCommands.keys()],
      registerShortcut: (key, opts) => {
        const normalized = normalizeShortcut(key);
        if (!/^(ctrl|meta)\+/.test(normalized)) {
          throw new Error(`Extension "${id}" shortcut "${key}" must include ctrl or meta.`);
        }
        if (RESERVED_SHORTCUTS.has(normalized)) {
          throw new Error(`Extension "${id}" cannot register the reserved shortcut "${normalized}".`);
        }
        shortcuts.set(normalized, { ...opts, owner: id, ctx: extCtx });
        extensionsChanged();
        return track(() => {
          if (shortcuts.get(normalized)?.owner !== id) return;
          shortcuts.delete(normalized);
          extensionsChanged();
        });
      },
      registerCommand: (name, command) => {
        extensionCommands.set(name, {
          info: {
            name,
            description: command.description,
            ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
            ...(command.options ? { hasOptions: true } : {}),
            ...(command.selectorTitle ? { selectorTitle: command.selectorTitle } : {}),
          },
          command,
          ctx: extCtx,
        });
        reg.undo.push(() => {
          if (extensionCommands.get(name)?.ctx === extCtx) extensionCommands.delete(name);
        });
        extensionsChanged();
      },
      setStatus: (text, opts) => {
        registerUndoOnce('status', () => extensionStatus.delete(id));
        if (text === undefined) {
          if (!extensionStatus.delete(id)) return;
        } else {
          const next = { id, text, ...(opts?.since !== undefined ? { since: opts.since } : {}) };
          if (sameJson(extensionStatus.get(id), next)) return;
          extensionStatus.set(id, next);
        }
        extensionsChanged();
      },
      setState: (key, value) => {
        registerUndoOnce(`state:${key}`, () => extensionState.delete(key));
        if (value === undefined) {
          if (!extensionState.delete(key)) return;
        } else {
          if (sameJson(extensionState.get(key), value)) return;
          // 存副本:扩展后续原地改自己的数组不该悄悄改变已发布的快照。
          extensionState.set(key, structuredClone(value));
        }
        extensionsChanged();
      },
      notify: (level, message) => bus.emit({ type: 'notice', level, message }),
      publishRuntime: (key, get) => {
        extensionRuntime.set(key, get);
        registerUndoOnce(`runtime:${key}`, () => {
          if (extensionRuntime.get(key) === get) extensionRuntime.delete(key);
        });
      },
      sendMessage: (message, opts) =>
        agent.sendMessage(message.customType, message.content, {
          ...(message.display !== undefined ? { display: message.display } : {}),
          ...(opts?.triggerTurn ? { triggerTurn: true } : {}),
        }),
      registerMessageRenderer: (customType, renderer) => {
        messageRenderers = setRenderer(messageRenderers, customType, renderer);
        reg.undo.push(() => {
          if (messageRenderers.get(customType) !== renderer) return;
          messageRenderers = setRenderer(messageRenderers, customType, undefined);
        });
        extensionsChanged();
      },
      // 两种形状(见 ExtensionAPI.registerTool):Pi 的定义对象经适配器转成工厂。
      registerTool: (
        nameOrDefinition: string | ExtensionToolDefinition,
        factory?: ExtensionToolFactory,
        meta?: ExtensionToolMeta,
      ) => {
        if (typeof nameOrDefinition === 'object') {
          const definition = nameOrDefinition;
          trackTool(definition.name);
          registerToolImpl(
            id,
            definition.name,
            adaptToolDefinition(definition, { bus, ctx: () => extCtx }),
            {
              promptSnippet: definition.promptSnippet,
              promptGuidelines: definition.promptGuidelines,
              ...(definition.renderCall ? { renderCall: definition.renderCall.bind(definition) } : {}),
              ...(definition.renderResult ? { renderResult: definition.renderResult.bind(definition) } : {}),
            },
          );
          return;
        }
        trackTool(nameOrDefinition);
        registerToolImpl(id, nameOrDefinition, factory!, meta);
      },
      unregisterTool: (name) => {
        dropTool(name);
        extensionsChanged();
      },
      getAllTools: () => Object.keys(tools),
      getActiveTools: () => Object.keys(tools).filter(isToolActive),
      setActiveTools: (names) => {
        activeTools = names ? new Set(names) : undefined;
      },
      registerFlag: (name, opts) => {
        flagDecls.set(name, opts);
        registerUndoOnce(`flag:${name}`, () => {
          if (flagDecls.get(name) === opts) flagDecls.delete(name);
        });
      },
      getFlag,
      // 扩展发起的消息标 source: 'extension'——不再过别的扩展的 input 钩子。
      run: (text, opts) => agent.run(text, { ...opts, source: 'extension' }),
      followUp: (text, opts) => agent.followUp(text, { ...opts, source: 'extension' }),
      isRunning: () => agent.isRunning,
      abort: () => agent.abort(),
      history: () => agent.history,
      compact: () => agent.compact(),
      getContextUsage: () => {
        const { used, window } = agent.contextUsage;
        return { used, window, percent: window > 0 ? (used / window) * 100 : 0 };
      },
      // store 是可变绑定(/new、/resume 换掉它),闭包现读才写进当前会话。
      appendEntry: (type, data) => store.saveCustom(type, data),
      entries: (type) => store.custom(type),
      getSessionName: () => store.meta.title,
      setSessionName: async (name) => {
        await SessionStore.rename(store.id, name);
        store.setTitle(name);
      },
      config,
      // 现取而不是提前建好:`/models`、`/provider` 换过之后 provider 是个新对象,
      // 提前建的模型会一直打向已经被换掉的那个服务端。createModel 只是本地
      // 构造,没有网络往返。
      model: (modelId) => createModel(modelId ? { ...provider, model: modelId } : provider),
      getModel: () => ({ provider: provider.id, model: provider.model }),
      setModel: async (change) => {
        switchProvider(change);
      },
      getThinkingLevel: () => provider.reasoningEffort,
      setThinkingLevel: async (level) => {
        setReasoningEffort(level);
      },
      exec: async (command, args, opts) => {
        const result = await execa(command, [...args], {
          cwd: opts?.cwd ?? root,
          reject: false,
          ...(opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
          ...(opts?.signal ? { cancelSignal: opts.signal } : {}),
          ...(opts?.env ? { env: opts.env } : {}),
        });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? -1 };
      },
    };
  };
  const disabled = new Set(options.disabledExtensions ?? []);
  const loadedIds = new Set<string>();
  for (const extension of BUILTIN_EXTENSIONS) {
    if (disabled.has(extension.id)) continue;
    await extension.setup(createExtensionApi(extension.id));
    loadedIds.add(extension.id);
  }
  /**
   * 磁盘扩展(包 / 全局目录 / 项目目录 / 配置 / `-e`)。与一方扩展的差别只有
   * 一条纪律:**任何一个装不上都不能拖垮会话**——文件解析失败、setup 抛错、
   * id 与已装的撞车,一律变成一条提示然后跳过(启动时进 startupNotices,
   * `/reload` 时直接上 bus)。一方扩展装不上则照常抛(那是我们自己的 bug,
   * 该在 CI 里红)。
   */
  const diskExtensionIds = new Set<string>();
  let extensionGeneration = 0;
  const loadDiskExtensions = async (
    report: (level: 'warn' | 'info', message: string) => void,
  ): Promise<{ loaded: string[]; failed: string[] }> => {
    const loaded: string[] = [];
    const failed: string[] = [];
    const { extensions: discovered, notFound } = await discoverExtensions({
      root,
      extraPaths: options.extensionPaths ?? [],
      configPaths: config.extensions,
      packages: resolved.packages,
    });
    for (const file of notFound) report('warn', t('notice.extensionPathMissing', { file }));
    // **先并发 import,再按序 setup**:import/jiti 转译是这里最贵的一步,而
    // 每个文件互不相干(发现那一步早就是并发的);顺序语义全在 setup 那一遍
    // (后装的同名覆盖先装的、按 id 去重),所以并发装载不影响它。
    const modules = await Promise.all(
      discovered.map(async (entry) => {
        if (disabled.has(entry.id)) return undefined;
        try {
          return { entry, extension: await loadExtension(entry, { generation: extensionGeneration }) };
        } catch (err) {
          return { entry, error: err };
        }
      }),
    );
    for (const item of modules) {
      if (!item) continue;
      const { entry } = item;
      try {
        if ('error' in item) throw item.error;
        const { extension } = item;
        if (disabled.has(extension.id)) continue;
        if (loadedIds.has(extension.id)) {
          report('warn', t('notice.extensionDuplicate', { id: extension.id, file: entry.file }));
          failed.push(extension.id);
          continue;
        }
        await extension.setup(createExtensionApi(extension.id));
        loadedIds.add(extension.id);
        diskExtensionIds.add(extension.id);
        loaded.push(extension.id);
      } catch (err) {
        report('warn', t('notice.extensionLoadFailed', { id: entry.id, file: entry.file, message: errorMessage(err) }));
        failed.push(entry.id);
      }
    }
    return { loaded, failed };
  };
  await loadDiskExtensions((level, message) => startupNotices.push({ level, message }));
  /**
   * `/reload`:只动磁盘扩展——逐个撤销注册、换一代模块缓存、重新发现与装载。
   * 一方扩展不动(它们是代码库的一部分,改了就该重启)。失败的照旧变提示。
   */
  const reloadExtensions = async (): Promise<{ loaded: string[]; failed: string[] }> => {
    for (const id of [...diskExtensionIds]) {
      await unloadExtension(id);
      loadedIds.delete(id);
      diskExtensionIds.delete(id);
    }
    extensionGeneration += 1;
    return loadDiskExtensions((level, message) => bus.emit({ type: 'notice', level, message }));
  };

  // 扩展贡献的技能目录(resources_discover):追加后重扫一次,skill 工具随之重建。
  {
    const { skillPaths } = await hooks.resourcesDiscover();
    if (skillPaths.length > 0) {
      skillManager.addDirs(skillPaths.map((p) => path.resolve(root, p)));
      await skillManager.list().catch(() => {});
      syncSkillTool();
    }
  }

  const runCommand = async (name: string, args: string): Promise<void> => {
    const entry = extensionCommands.get(name);
    if (!entry) throw new Error(`Unknown command: ${name}`);
    await entry.command.handler(args, entry.ctx);
  };

  if (options.resume) {
    agent.setHistory([...options.resume.messages]);
  }
  // 扩展从会话记录恢复自己的状态(如 /goal 的条件)。在历史与状态换好之后。
  await hooks.notify('session_start', { reason: 'startup' });

  // ---- 会话切换(/new、/resume、/fork 与扩展的 ctx.newSession / switchSession / fork 共用) ----
  const newSessionImpl = async (): Promise<SessionStore> => {
    store = await SessionStore.create({ root, provider: provider.id, model: provider.model });
    agent.clear();
    resetSkillActivation();
    await hooks.notify('session_start', { reason: 'new' });
    bus.emit({ type: 'session-changed', reason: 'new', id: store.id });
    return store;
  };
  const resumeSessionImpl = async (idOrPrefix: string): Promise<SessionStore> => {
    // 扩展可取消(session_before_switch);取消以错误呈现,调用方按失败提示。
    if ((await hooks.cancelable('session_before_switch', { id: idOrPrefix })).cancel) {
      throw new Error('Session switch cancelled by an extension.');
    }
    const id = await SessionStore.resolveId(idOrPrefix, { root });
    const opened = await SessionStore.open(id);
    store = opened;
    // 上一段对话点名的技能不能漂进另一段对话。
    resetSkillActivation();
    // 换的是另一段对话:累计用量一并归零(见 setHistory 的注释)。
    agent.setHistory([...opened.messages], { resetSpend: true });
    // 刻意不切回会话记录的 provider/model:恢复的是对话内容,模型始终
    // 沿用当前正在用的那一个。反过来把 meta 更新成当前模型,列表里那一行
    // 才不会继续宣称一个这段对话往后都不会再用的模型。
    opened.setModel(provider.id, provider.model);
    await hooks.notify('session_start', { reason: 'resume' });
    bus.emit({ type: 'session-changed', reason: 'resume', id: opened.id });
    return opened;
  };
  const forkSessionImpl = async (): Promise<SessionStore> => {
    if ((await hooks.cancelable('session_before_fork', undefined)).cancel) {
      throw new Error('Session fork cancelled by an extension.');
    }
    // 与 --fork-session 同一条路:eager 拷贝进新文件,源会话从此不再被写。
    // 内存里的历史一概不动——分叉的意义就是"一切照旧,换个 id"。
    store = await store.fork({ provider: provider.id, model: provider.model });
    await hooks.notify('session_start', { reason: 'fork' });
    bus.emit({ type: 'session-changed', reason: 'fork', id: store.id });
    return store;
  };

  const switchProvider = (change: {
    provider?: string;
    model?: string;
    apiKey?: string;
  }): ResolvedProvider => {
    if (change.provider && change.apiKey) {
      // 刚在 TUI 里输入的 key:client 侧已落盘,但本进程的配置是启动时加载的
      // 快照,不合并的话 resolveProvider 会按"缺 key"拒绝切换。
      config.providers[change.provider] = {
        ...config.providers[change.provider],
        apiKey: change.apiKey,
      };
    }
    const next = resolveProvider({
      ...config,
      provider: change.provider ?? config.provider,
      // 单独的 `/models x` 保留当前 provider;不带模型切换 provider 时,
      // 必须回退到该 provider 的默认模型,而不是沿用旧的模型 id。
      model: change.model ?? (change.provider ? undefined : config.model),
    });
    config.provider = next.id;
    config.model = next.model;
    provider = next;
    agent.updateModel(createModel(next), next);
    // 视觉模型的可解析性随 provider 变(deepseek/无预设的端点解析不出):
    // 同步工具注册,信封与后续系统提示词重建才与新 provider 一致。
    syncViewImageTool();
    // meta 的 provider/model 现在纯粹是给会话列表看的("这段对话用的什么
    // 模型"),不跟着切就会一直停在创建时的值。
    store.setModel(next.id, next.model);
    // 通知型钩子,不等它:切换本身是同步语义,扩展的反应在后台跑。
    void hooks.notify('model_select', { provider: next.id, model: next.model });
    return next;
  };

  const setReasoningEffort = (level: ReasoningEffort): void => {
    // provider 与 agent 持有同一个 ResolvedProvider 对象,改字段即可让下一次
    // streamText 生效;同时写回内存配置,使 /models、/provider 重新 resolve
    // 时不丢失本次选择。(从 App.tsx 的 /think 分支原样收编。)
    provider.reasoningEffort = level;
    config.providers[provider.id] = {
      ...(config.providers[provider.id] ?? {}),
      reasoningEffort: level,
    };
    void hooks.notify('thinking_level_select', { level });
  };

  /**
   * 以用户身份调用技能(`/技能名`)。fork 技能不展开正文,只给模型一行英文
   * 指令让它调 skill 工具——正文全程不进主上下文,进度/落盘/中断都走 task
   * 的现成轨道;pendingUserSkills 在轮内放行 disable-model-invocation。
   */
  const runSkill = async (
    name: string,
    args: string,
    options?: { display?: string },
  ): Promise<void> => {
    await skillManager.list().catch(() => {});
    syncSkillTool();
    const meta = skillManager.find(name);
    if (!meta || !meta.userInvocable) {
      throw new Error(`Unknown skill: ${name}`);
    }
    const display = options?.display ?? `/${name}${args ? ` ${args}` : ''}`;

    if (meta.context === 'fork') {
      const directive =
        `Run the skill "${meta.name}" by calling the skill tool with name "${meta.name}"` +
        (args ? ` and arguments ${JSON.stringify(args)}` : '') +
        ', then relay its report to the user.';
      skillActivation.pendingUserSkills.add(meta.name);
      try {
        await agent.run(wrapSkillPrompt(display, directive), { display, source: 'skill' });
      } finally {
        skillActivation.pendingUserSkills.delete(meta.name);
      }
      return;
    }

    const body = await readSkillBody(meta);
    await agent.run(wrapSkillPrompt(display, substituteArgs(body, args)), {
      display,
      source: 'skill',
    });
  };

  /**
   * `/simplify` 的执行侧(对齐 Claude Code 的多 agent 形态),两阶段:
   *  1. 四个只读 explore 子代理并行,每轴一整份专属上下文与独立步数预算
   *     (task.ts 的 runTaskSubagent——explore 模式不弹确认,过程落盘可回查);
   *     编排与合成工具事件在 simplify.ts 的 runAxisReviews,让阶段一的进度
   *     在 UI 里有宿主行可贴;
   *  2. 主对话拿全四份报告跑应用轮:去重、对照现状核实、应用修复(未提交)。
   * 失败的轴保留位置并明说覆盖不全,不静默少审一个维度;全轴失败也照常进
   * 应用轮——提示词会把"无报告"交代成空清理,由模型如实总结。
   */
  const startSimplify = async (
    targetArg: string,
    options?: { display?: string },
  ): Promise<SimplifyStartResult> => {
    const scope = parseSimplifyArg(targetArg);
    if (!scope) return { ok: false, reason: 'bad-arg' };
    const collected = await collectReviewSummary(root, scope);
    if (!collected.ok) return collected;
    const trimmed = targetArg.trim();
    const display = options?.display ?? (trimmed ? `/simplify ${trimmed}` : '/simplify');

    // 阶段一可能跑几分钟,先给时间线一条交代(此时应用轮的 turn-start 还没来)。
    bus.emit({ type: 'notice', level: 'info', message: t('notice.simplifyAxes') });
    const sections = await runAxisReviews(scope, collected.summary, {
      bus,
      run: (opts) => runTaskSubagent(taskDeps, opts),
    });

    await agent.run(
      wrapSkillPrompt(display, buildSimplifyApplyPrompt(scope, collected.summary, sections)),
      { display, source: 'skill' },
    );
    return { ok: true };
  };

  return {
    root,
    config,
    get provider() {
      return provider;
    },
    get env() {
      return env;
    },
    agent,
    bus,
    hooks,
    startupNotices,
    get store() {
      return store;
    },
    newSession: newSessionImpl,
    resumeSession: resumeSessionImpl,
    forkSession: forkSessionImpl,
    switch: switchProvider,
    setReasoningEffort,
    listProviderModels: () => listProviderModels(config),
    // 返回**生效可选集**,不是目录原文:回退与 wire 可表达性过滤都做在这里,
    // 三个前端(TUI /think 选择器与校验、GUI 思考菜单、模型弹窗)直接渲染。
    // 放前端做过两次都是错的——家族表是 server-only 模块,renderer 摸不到,
    // 同一个目录缺口 TUI 会收窄、GUI 却列出模型根本不支持的档位。
    modelCapabilities: async (providerId, modelId) => {
      const catalog = await catalogSource.get();
      const caps = catalog ? capabilitiesFor(catalog, providerId, modelId) : undefined;
      // 目标 provider/model 的 wire 能力:probe 模式,缺 key 不抛(弹窗查的
      // 可能是还没配 key 的厂商)。解析失败(连 baseURL 都没有)只能交回目录原文。
      let target: ResolvedProvider;
      try {
        target = resolveProvider({ ...config, provider: providerId, model: modelId }, process.env, {
          probe: true,
        });
      } catch {
        return caps;
      }
      return { ...caps, efforts: effectiveEfforts(target, caps?.efforts) };
    },
    doctor: async ({ offline }) => {
      // 会话内已经拉起来的子进程直接采信状态,doctor 不再自己连/拉一份。两份
      // 都由扩展发布(publishRuntime),扩展没装时为 undefined——那不是"一个
      // 都没起来",doctor 会自己去探测。MCP 那份是**连接收尾后**的数组:半满
      // 的会被当成权威(没落地的 server 一律报 fail · "?")还把退出码带成 1,
      // 所以扩展给的是个 promise,这里一并 await。
      const [mcpStatuses, lspStatuses] = await Promise.all([
        runtimeOf<McpStatus[]>(MCP_RUNTIME_KEY),
        runtimeOf<LspRuntimeStatus[]>(LSP_RUNTIME_KEY),
      ]);
      return runDoctor({
        root,
        config,
        mcpStatuses,
        // 没人发布过 MCP 快照 = mcp 扩展没装(`--no-mcp`)。LSP 那边不需要
        // 这一条:它的 getter 装了也可能返回 undefined(还没触发过),两种
        // 情形对 doctor 都是"去探一下"。
        mcpOff: !extensionRuntime.has(MCP_RUNTIME_KEY),
        lspStatuses,
        offline,
      });
    },
    refreshEnvironment: async () => {
      env = await gatherEnvironment(root);
      agent.updateSystemPrompt(
        buildSystemPrompt(env, { viewImage: viewImageFor(provider) }, config.systemPromptAppend),
      );
    },
    get skills() {
      return skillManager.commandInfos();
    },
    skillsChanged: (listener: () => void) => skillManager.subscribe(listener),
    refreshSkills: async () => {
      await skillManager.refresh().catch(() => {});
      syncSkillTool();
      return skillManager.commandInfos();
    },
    runSkill,
    get extensionCommands() {
      return [...extensionCommands.values()].map((entry) => entry.info);
    },
    get extensionStatus() {
      return [...extensionStatus.values()];
    },
    get extensionState() {
      return Object.fromEntries(extensionState);
    },
    commandOptions: async (name: string, path?: string[]) => {
      const entry = extensionCommands.get(name);
      return (await entry?.command.options?.(path ?? [])) ?? [];
    },
    extensionsChanged: (listener: () => void) => {
      extensionListeners.add(listener);
      return () => {
        extensionListeners.delete(listener);
      };
    },
    runCommand,
    get uiRequests() {
      return [...uiPending.values()].map((entry) => entry.request);
    },
    answerUi,
    attachUi: (host) => {
      uiHost = host;
    },
    runShortcut: (key) => {
      // 常态是一个扩展快捷键都没注册:早退,别为每次 ctrl/meta 按键白算一遍。
      // key 由调用方给出归一形态(TUI 的 shortcutOf),这里不再归一第二遍。
      if (shortcuts.size === 0) return false;
      const entry = shortcuts.get(key);
      if (!entry) return false;
      // 处理器可能是异步的;失败经 notice 呈现,绝不掀掉键盘处理器。
      void Promise.resolve(entry.handler(entry.ctx)).catch((err: unknown) => {
        bus.emit({
          type: 'notice',
          level: 'warn',
          message: t('notice.hookFailed', { hook: `shortcut ${key}`, message: errorMessage(err) }),
        });
      });
      return true;
    },
    get uiCustoms() {
      return [...uiCustoms.values()].map((entry) => entry.request);
    },
    resolveCustom,
    // 三份都**换引用不就地改**(见各自声明处),所以这里原样交出去:内容
    // 没变身份就没变,TUI 侧的信号不会被每次 extensionsChanged 白唤醒一遍
    // (todo 每次工具调用都会跳一次,而它一跳就要重算整条时间线的画法)。
    get uiSurfaces() {
      return uiSurfaces;
    },
    get toolRenderers() {
      return toolRenderers;
    },
    get messageRenderers() {
      return messageRenderers;
    },
    reloadExtensions,
    startSimplify,
    // 子进程(MCP 的 stdio server、LSP 的语言服务器)由各自的扩展在
    // session_shutdown 里关,包括「连接还在路上时会话就关了」的孤儿竞态。
    // 还挂着的提问先按「没答」兑现,等它的扩展才不会永远挂在 await 上。
    dispose: async () => {
      for (const id of [...uiPending.keys()]) answerUi(id, undefined);
      for (const id of [...uiCustoms.keys()]) resolveCustom(id, undefined);
      await hooks.notify('session_shutdown', undefined);
    },
  };
}
