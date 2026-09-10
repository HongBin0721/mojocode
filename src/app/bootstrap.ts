import type { ModelMessage, ToolSet } from 'ai';
import { Agent } from '../agent/loop.js';
import { BUILTIN_EXTENSIONS } from '../extensions/index.js';
import { discoverExtensions, loadExtension } from '../extensions/loader.js';
import { resolvePackages } from '../extensions/packages.js';
import { LSP_RUNTIME_KEY } from '../extensions/lsp/index.js';
import { MCP_RUNTIME_KEY } from '../extensions/mcp/index.js';
import type {
  ExtensionAPI,
  ExtensionCommand,
  ExtensionCommandInfo,
  ExtensionStatusEntry,
  ExtensionCommandOption,
  ExtensionToolFactory,
  ToolScope,
} from '../core/extension.js';
import { buildSystemPrompt, gatherEnvironment, type EnvironmentInfo } from '../agent/prompt.js';
import { resolveProvider, type LoadedConfig, type ResolvedProvider } from '../config/load.js';
import { imagesDir } from '../config/paths.js';
import { providerModelIsVision, resolveVisionModelId } from '../config/providers.js';
import { createViewImageTool } from '../tools/view-image.js';
import {
  providerConfigSchema,
  type Config,
  type ProviderConfig,
  type ReasoningEffort,
} from '../config/schema.js';
import { deleteProviderEntry, saveProviderEntry } from '../config/save.js';
import { runDoctor, type DoctorReport } from './doctor.js';
import { EventBus } from '../core/events.js';
import { errorMessage } from '../core/errors.js';
import { HookRegistry } from '../core/hooks.js';
import {
  createModel,
  listModels,
  listProviderModels,
  testModel as testModelConnection,
  type ModelInfo,
  type ModelTestResult,
  type ProviderModels,
} from '../model/registry.js';
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
import {
  SessionStore,
  type ChangedFileEntry,
  type SessionMeta,
  type SessionState,
} from '../session/store.js';
import { listWorkspaceFiles } from './file-index.js';
import { readWorkspaceFile, type FileContent } from './workspace-read.js';
import {
  commitAll as gitCommitAll,
  discardAll as gitDiscardAll,
  switchBranch as gitSwitchBranch,
  undoCommit as gitUndoCommit,
  type GitOpResult,
} from '../agent/workspace-write.js';
import { t } from '../i18n/index.js';
import fs from 'node:fs/promises';
import { SkillManager } from '../skills/manager.js';
import { createSkillTool } from '../skills/tool.js';
import { readSkillBody, type SkillCommandInfo } from '../skills/discovery.js';
import { substituteArgs } from '../skills/substitute.js';
import { wrapSkillPrompt } from '../skills/invocation.js';
import {
  collectReviewSummary,
  collectReviewTargets,
  type ReviewTargets,
} from '../agent/review.js';
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
   * 归档/取消归档任意会话(GUI 任务列表)。目标是当前活跃会话时同步内存
   * meta——save() 每轮用内存 meta 重写记录,只改磁盘会在下一轮被冲掉。
   */
  archiveSession: (id: string, archived: boolean) => Promise<SessionMeta>;
  /** 重命名任意会话(设 title);活跃会话同步内存 meta,理由同上。 */
  renameSession: (id: string, title: string) => Promise<SessionMeta>;
  /** 真删磁盘文件。当前活跃会话拒绝删除(serve 正拿着它写)。 */
  deleteSession: (id: string) => Promise<void>;
  /** GUI 文件树的数据源:工作区扁平文件清单(git ls-files 优先)。 */
  listFiles: () => Promise<{ files: string[]; truncated: boolean }>;
  /** GUI 文件预览:server 侧读文件(--attach 时仓库在 server 那台机器)。 */
  readFile: (path: string) => Promise<FileContent>;
  /** 本会话经 write/edit 落地过的文件(任务视角变更索引,进 StateSnapshot)。 */
  readonly changedFiles: ChangedFileEntry[];
  /**
   * 工作区 git 写操作(GUI 上的显式操作,不是模型工具;见 workspace-write.ts
   * 的信任模型)。commit/discard 成功后清空 changedFiles(pending 已结清)。
   */
  switchBranch: (name: string) => Promise<GitOpResult>;
  commitAll: (message: string) => Promise<GitOpResult>;
  undoCommit: () => Promise<GitOpResult>;
  discardAll: () => Promise<GitOpResult>;
  /**
   * 会话中途切换模型和/或 provider;返回新解析的 provider。apiKey 只在
   * "TUI 就地输入了新 key"的切换里出现,由实现并入配置后再解析。
   * 远程会话(client-server 模式)下是异步的,调用方一律 await。
   */
  switch: (change: { provider?: string; model?: string; apiKey?: string }) => ResolvedProvider | Promise<ResolvedProvider>;
  /**
   * GUI 模型设置的保存入口:把一次编辑(baseURL / apiKey / label / models
   * 的任意子集)并入内存 `config.providers[id]` 并落盘全局配置。patch 只含
   * 用户真正改过的键——GUI 拿到的配置是脱敏副本,整对象回写会用空值覆盖
   * 真 key。编辑的是当前 provider 时尽力重解析,让 label / 逐模型
   * contextWindow 立即生效。
   */
  saveProvider: (id: string, patch: ProviderConfig) => void | Promise<void>;
  /** GUI 模型设置的删除入口:整条移除 `providers.<id>`。当前激活的 provider 拒绝删除。 */
  deleteProvider: (id: string) => void | Promise<void>;
  /**
   * 调整当前 provider 的思考档位(`/think`)。直接改 provider/config 字段的
   * 老写法在 client-server 模式下改的只是本地镜像,必须收进 Session 契约
   * 才能落到真正跑模型的那个进程。
   */
  setReasoningEffort: (level: ReasoningEffort) => void | Promise<void>;
  /**
   * 拉取**所有已配置厂商**的模型列表(`/models` 分组选择器):并发探测,
   * 单组失败不抛错、就地带回原因。收进契约:凭据只存在于 server 侧。
   */
  listProviderModels: () => Promise<ProviderModels[]>;
  /** GUI「测试模型」:向对话端点发一次最小补全,验证 baseURL/key/模型 id。 */
  testModel: (providerId: string, modelId: string) => Promise<ModelTestResult>;
  /** 逐模型能力(models.dev 目录),见 src/model/catalog.ts。 */
  modelCapabilities: (providerId: string, modelId: string) => Promise<ModelCapabilities | undefined>;
  /**
   * 只拉**当前厂商**的模型列表。新代码用 listProviderModels,这个方法
   * 只剩 server 的 listModels 兼容垫片在调(旧 --attach 客户端的版本偏差
   * 路径)——垫片转发到 listProviderModels 会把 1 次探测放大成全厂商并发
   * 探测,还得等最慢的一个,旧语义必须保住单厂商。
   */
  listModels: () => Promise<ModelInfo[]>;
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
  /** 扩展注册的斜杠命令投影(菜单用),同步读取(远程侧走 SSE 镜像)。 */
  readonly extensionCommands: ExtensionCommandInfo[];
  /** 扩展贴在输入框上方的状态行,同步读取(远程侧走 SSE 镜像)。 */
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
   * 本地分支列表(server 侧跑 git:当前分支 + 其余本地分支,按最近提交
   * 排序)。远程侧普通 RPC——快、小、不跑 agent。
   *
   * `/review` 的选择器不再经它——那条命令是扩展,自己在会话进程里跑 git;
   * 留下这条是给 GUI 顶栏的**分支切换器**用的,它与评审无关。
   */
  reviewTargets: () => Promise<ReviewTargets>;
  /**
   * 以用户身份跑一轮代码清理(`/simplify`,对齐 Claude Code):解析目标 →
   * 复用 review.ts 的收集器 → 组稿清理提示词交给 agent.run,模型在这一轮里
   * 直接应用修复(编辑工作区、保持未提交)。失败同样以 reason 代码返回;
   * 远程侧 deferred RPC(包 agent.run)。
   */
  startSimplify: (targetArg: string, options?: { display?: string }) => Promise<SimplifyStartResult>;
  dispose: () => Promise<void>;
}

/**
 * 旧版 server 的 `resumeSession` 会尝试切回会话记录的 provider/model,失败时
 * 抛出这个标记错误("历史已恢复,只是没切成模型")。现在恢复不再动模型,
 * 本进程不会再抛它;类保留是为了 `--attach` 到旧版 server 时 wire 上的
 * ProviderSwitchError 仍能复原类型、走降级提示而不是整次恢复报失败。
 */
export class ProviderSwitchError extends Error {
  constructor(cause: Error) {
    super(cause.message);
    this.name = 'ProviderSwitchError';
  }
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
  const hooks = new HookRegistry(({ hook, error }) => {
    bus.emit({
      type: 'notice',
      level: 'warn',
      message: t('notice.hookFailed', { hook, message: error.message }),
    });
  });
  // models.dev 能力目录:懒加载 + 磁盘缓存(首个 modelCapabilities 调用才拉取)。
  const catalogSource = createCatalogSource();

  /**
   * 本会话经 write/edit 落地过的文件(任务视角的变更索引,进 StateSnapshot
   * 与 SessionState)。局限写在明面上:bash 里的 git checkout / rm / 脚本生成
   * 不会进列表也不会失效既有条目——GUI 的权威 pending 视图仍是
   * workspaceStatus(git 真相),这份列表只回答「这个任务改过哪些文件」。
   * 封顶 1000 条,超出丢弃(极端会话的快照体积保护)。
   */
  const changedFiles = new Map<string, { kind: 'created' | 'modified'; count: number }>();
  const CHANGED_FILES_MAX = 1000;
  const changedFilesList = (): Array<{ path: string; kind: 'created' | 'modified'; count: number }> =>
    // 按 path 排序输出:snapshotKey 靠整份快照 stringify 去重,插入序抖动
    // 会产生伪推送。
    [...changedFiles.entries()]
      .map(([path, entry]) => ({ path, ...entry }))
      .sort((a, b) => a.path.localeCompare(b.path));
  const restoreChangedFiles = (
    entries: Array<{ path: string; kind: 'created' | 'modified'; count: number }> | undefined,
  ): void => {
    changedFiles.clear();
    for (const entry of entries ?? []) {
      changedFiles.set(entry.path, { kind: entry.kind, count: entry.count });
    }
  };

  // 会话状态快照:目前只有变更索引。store 在下方才创建,闭包按绑定取值。
  const snapshotState = (): SessionState => ({
    // 空时整个字段不出现:老会话的状态记录 JSON 保持一字不差,脏检查不会
    // 平白多写一条记录。
    ...(changedFiles.size > 0 ? { changedFiles: changedFilesList() } : {}),
  });
  const persistState = (): void => {
    void store.saveState(snapshotState()).catch(() => {
      // 状态是尽力而为的附属信息,失败不打扰用户(消息保存失败才提示)。
    });
  };

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
    onHistoryChange: (messages: ModelMessage[]) => {
      void store.save(messages).catch((err: Error) => {
        bus.emit({ type: 'notice', level: 'warn', message: t('notice.sessionSaveFailed', { message: err.message }) });
      });
      persistState(); // 轮界兜底;脏检查保证状态没变时不产生记录
    },
  });

  // 轮末把本轮真实用量随会话落盘(kind: 'usage',恢复回放不读、旧版本安全
  // 跳过)。缓存命中率与成本核算都靠逐轮数据,而消息流里无从还原。取当下的
  // provider:/models 换过之后统计要记到实际服务的那个模型头上。尽力而为,
  // 失败只静默——统计缺一轮远好过打断一次会话。
  // 聚合 write/edit 落地的文件(见 changedFiles 声明处的语义与局限)。
  bus.on((event) => {
    if (event.type !== 'tool-end' || event.isError) return;
    if (event.toolName !== 'write' && event.toolName !== 'edit') return;
    const out = event.output as { path?: string; changed?: boolean; created?: boolean } | undefined;
    if (!out?.path || out.changed === false) return; // write 的"内容相同"短路不算变更
    const prev = changedFiles.get(out.path);
    if (prev) {
      // created 只在首次为真;后续 edit 不把 kind 降级回 modified 之外的状态。
      changedFiles.set(out.path, { kind: prev.kind, count: prev.count + 1 });
    } else if (changedFiles.size < CHANGED_FILES_MAX) {
      changedFiles.set(out.path, { kind: out.created ? 'created' : 'modified', count: 1 });
    }
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
  const extensionCommands = new Map<string, { info: ExtensionCommandInfo; command: ExtensionCommand }>();
  const extensionStatus = new Map<string, ExtensionStatusEntry>();
  /** 扩展发布给客户端的结构化状态(见 ExtensionAPI.setState),随快照过线。 */
  const extensionState = new Map<string, unknown>();
  const extensionListeners = new Set<() => void>();
  const extensionsChanged = (): void => {
    for (const listener of extensionListeners) listener();
  };
  /**
   * 值没变就不通知。一次 extensionsChanged 在 serve 侧要走完
   * `computeState()`(重建 redactConfig 的两张表、排一遍变更文件、四个扩展
   * 投影)再对整份快照做一次 `JSON.stringify` 去重——比在这里把一个小值
   * 序列化一遍贵得多。重复发布是常态而非例外:todo 每次工具调用都重发整份
   * 清单(哪怕只是把一项从 pending 挪到 in_progress),而那次调用自己的
   * tool-end 已经推过一帧了。
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
  const createExtensionApi = (id: string): ExtensionAPI => ({
    id,
    root,
    on: (name, handler) => hooks.on(name, handler),
    onEvent: (handler) => bus.on(handler),
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
      });
      extensionsChanged();
    },
    setStatus: (text, opts) => {
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
    publishRuntime: (key, get) => extensionRuntime.set(key, get),
    registerTool: (name, factory) => {
      if (BUILTIN_TOOL_NAMES.has(name)) {
        throw new Error(`Extension "${id}" cannot register the builtin tool "${name}".`);
      }
      extensionTools.set(name, factory);
      syncExtensionTool(name);
    },
    unregisterTool: (name) => {
      extensionTools.delete(name);
      syncExtensionTool(name);
    },
    run: (text, opts) => agent.run(text, opts),
    followUp: (text, opts) => agent.followUp(text, opts),
    isRunning: () => agent.isRunning,
    abort: () => agent.abort(),
    history: () => agent.history,
    // store 是可变绑定(/new、/resume 换掉它),闭包现读才写进当前会话。
    appendEntry: (type, data) => store.saveCustom(type, data),
    entries: (type) => store.custom(type),
    config,
    // 现取而不是提前建好:`/models`、`/provider` 换过之后 provider 是个新对象,
    // 提前建的模型会一直打向已经被换掉的那个服务端。createModel 只是本地
    // 构造,没有网络往返。
    model: (modelId) => createModel(modelId ? { ...provider, model: modelId } : provider),
  });
  const disabled = new Set(options.disabledExtensions ?? []);
  const loadedIds = new Set<string>();
  for (const extension of BUILTIN_EXTENSIONS) {
    if (disabled.has(extension.id)) continue;
    await extension.setup(createExtensionApi(extension.id));
    loadedIds.add(extension.id);
  }
  /**
   * 磁盘扩展(包 / 全局目录 / 项目目录 / `-e`)。与一方扩展的差别只有一条
   * 纪律:**任何一个装不上都不能拖垮会话**——文件解析失败、setup 抛错、id
   * 与已装的撞车,一律变成一条 startup notice 然后跳过。一方扩展装不上则
   * 照常抛(那是我们自己的 bug,该在 CI 里红)。
   */
  const { extensions: discovered, notFound } = await discoverExtensions({
    root,
    extraPaths: options.extensionPaths ?? [],
    packages: resolved.packages,
  });
  for (const file of notFound) {
    startupNotices.push({ level: 'warn', message: t('notice.extensionPathMissing', { file }) });
  }
  for (const entry of discovered) {
    if (disabled.has(entry.id)) continue;
    try {
      const extension = await loadExtension(entry);
      if (disabled.has(extension.id)) continue;
      if (loadedIds.has(extension.id)) {
        startupNotices.push({
          level: 'warn',
          message: t('notice.extensionDuplicate', { id: extension.id, file: entry.file }),
        });
        continue;
      }
      await extension.setup(createExtensionApi(extension.id));
      loadedIds.add(extension.id);
    } catch (err) {
      startupNotices.push({
        level: 'warn',
        message: t('notice.extensionLoadFailed', { id: entry.id, file: entry.file, message: errorMessage(err) }),
      });
    }
  }

  const runCommand = async (name: string, args: string): Promise<void> => {
    const entry = extensionCommands.get(name);
    if (!entry) throw new Error(`Unknown command: ${name}`);
    await entry.command.handler(args);
  };

  if (options.resume) {
    agent.setHistory([...options.resume.messages]);
    restoreChangedFiles(options.resume.state.changedFiles);
  }
  // 扩展从会话记录恢复自己的状态(如 /goal 的条件)。在历史与状态换好之后。
  await hooks.sessionStart({ reason: 'startup' });

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
    return next;
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
        await agent.run(wrapSkillPrompt(display, directive), { display });
      } finally {
        skillActivation.pendingUserSkills.delete(meta.name);
      }
      return;
    }

    const body = await readSkillBody(meta);
    await agent.run(wrapSkillPrompt(display, substituteArgs(body, args)), { display });
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
      { display },
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
    newSession: async () => {
      store = await SessionStore.create({ root, provider: provider.id, model: provider.model });
      agent.clear();
      changedFiles.clear();
      resetSkillActivation();
      persistState();
      await hooks.sessionStart({ reason: 'new' });
      return store;
    },
    resumeSession: async (idOrPrefix: string) => {
      const id = await SessionStore.resolveId(idOrPrefix, { root });
      const opened = await SessionStore.open(id);
      store = opened;
      // 上一段对话点名的技能不能漂进另一段对话。
      resetSkillActivation();
      // 换的是另一段对话:累计用量一并归零(见 setHistory 的注释)。
      agent.setHistory([...opened.messages], { resetSpend: true });
      restoreChangedFiles(opened.state.changedFiles);
      // 刻意不切回会话记录的 provider/model:恢复的是对话内容,模型始终
      // 沿用当前正在用的那一个。反过来把 meta 更新成当前模型,列表里那一行
      // 才不会继续宣称一个这段对话往后都不会再用的模型。
      opened.setModel(provider.id, provider.model);
      await hooks.sessionStart({ reason: 'resume' });
      return opened;
    },
    forkSession: async () => {
      // 与 --fork-session 同一条路:eager 拷贝进新文件,源会话从此不再被写。
      // 内存里的历史/todos/权限一概不动——分叉的意义就是"一切照旧,换个 id"。
      store = await store.fork({ provider: provider.id, model: provider.model });
      // 与 newSession 同理:fork 带过来的是源 store 里*已落盘*的 state_,若它
      // 落后于内存(saveState 静默失败过),分叉的 lastStateJson 也初始化成了
      // 同一份旧值,脏检查会一直压住重写。这里按当前真实状态补一次。
      persistState();
      await hooks.sessionStart({ reason: 'fork' });
      return store;
    },
    archiveSession: async (id, archived) => {
      // 先落盘(静态路径是权威写入),再同步活跃实例的内存 meta——顺序反过来
      // 也行,关键是两边一致;这里选"磁盘成功才改内存",失败时内存不脏。
      const meta = await SessionStore.setArchived(id, archived);
      if (id === store.id) store.setArchivedFlag(archived);
      return meta;
    },
    renameSession: async (id, title) => {
      const meta = await SessionStore.rename(id, title);
      if (id === store.id) store.setTitle(title);
      return meta;
    },
    deleteSession: async (id) => {
      // 拒绝删除活跃会话:serve 正拿着它写,删了下一轮 save 会凭空重建文件。
      // 措辞对齐 deleteProvider 的先例(英文过线,GUI 自己本地化)。
      if (id === store.id) {
        throw new Error(`Session "${id}" is active. Switch to another session first.`);
      }
      await SessionStore.remove(id);
    },
    listFiles: async () => {
      // GUI 文件树要的清单比 @ 补全菜单全:limit 提到 20000,打满视为截断。
      const limit = 20_000;
      const files = await listWorkspaceFiles(root, limit);
      return { files, truncated: files.length >= limit };
    },
    readFile: (filePath) => readWorkspaceFile(root, filePath),
    get changedFiles() {
      return changedFilesList();
    },
    switchBranch: (name) => gitSwitchBranch(root, name),
    commitAll: async (message) => {
      const result = await gitCommitAll(root, message);
      // pending 已结清,任务级变更索引一并清空(不发 notice:这是 GUI 发起的
      // 操作,结果走 RPC 返回值,广播会打扰同 server 的其他客户端)。
      if (result.ok) {
        changedFiles.clear();
        persistState();
      }
      return result;
    },
    undoCommit: () => gitUndoCommit(root),
    discardAll: async () => {
      const result = await gitDiscardAll(root);
      if (result.ok) {
        changedFiles.clear();
        persistState();
      }
      return result;
    },
    switch: switchProvider,
    saveProvider: async (id, patch) => {
      // 经 schema 过一遍:剥掉未知键(wire 上的 args 没有类型约束)、校验
      // 字段形状;再滤掉 undefined——只合并用户真正改过的键。
      const parsed = providerConfigSchema.parse(patch);
      const cleaned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== undefined) cleaned[key] = value;
      }
      config.providers[id] = { ...config.providers[id], ...(cleaned as ProviderConfig) };
      await saveProviderEntry(id, cleaned);
      // 编辑的是当前 provider 时重解析(空 change 的 switch 即"按当前配置
      // 重算"),label / 逐模型 contextWindow 立即生效;失败不回滚保存——
      // 条目被改坏的真实错误留给下一次显式切换报告。
      if (id === provider.id) {
        try {
          switchProvider({});
        } catch {
          /* 保存已完成;解析问题在下一次显式 switch 时浮现。 */
        }
      }
    },
    deleteProvider: async (id) => {
      // 拒绝删除激活条目:agent 正拿着它跑,删了内存与落盘立刻分叉。
      if (id === provider.id) {
        throw new Error(`Provider "${id}" is active. Switch to another provider first.`);
      }
      delete config.providers[id];
      await deleteProviderEntry(id);
    },
    setReasoningEffort: (level: ReasoningEffort) => {
      // provider 与 agent 持有同一个 ResolvedProvider 对象,改字段即可让下一次
      // streamText 生效;同时写回内存配置,使 /models、/provider 重新 resolve
      // 时不丢失本次选择。(从 App.tsx 的 /think 分支原样收编。)
      provider.reasoningEffort = level;
      config.providers[provider.id] = {
        ...(config.providers[provider.id] ?? {}),
        reasoningEffort: level,
      };
    },
    listProviderModels: () => listProviderModels(config),
    testModel: (providerId, modelId) => testModelConnection(config, providerId, modelId),
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
    listModels: () => listModels(provider),
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
    reviewTargets: () => collectReviewTargets(root),
    startSimplify,
    // 子进程(MCP 的 stdio server、LSP 的语言服务器)由各自的扩展在
    // session_shutdown 里关,包括「连接还在路上时会话就关了」的孤儿竞态。
    dispose: () => hooks.sessionShutdown(),
  };
}
