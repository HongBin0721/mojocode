import type { ModelMessage, ToolSet } from 'ai';
import { Agent } from '../agent/loop.js';
import { GoalController } from '../agent/goal.js';
import { buildSystemPrompt, gatherEnvironment, type EnvironmentInfo } from '../agent/prompt.js';
import { resolveProvider, type LoadedConfig, type ResolvedProvider } from '../config/load.js';
import { resolveSearchBackend } from '../config/search.js';
import {
  planReturnFor,
  type Config,
  type Permissions,
  type ReasoningEffort,
} from '../config/schema.js';
import { runDoctor, type DoctorReport } from './doctor.js';
import { EventBus, type PermissionAsker } from '../core/events.js';
import { createModel, listModels, listProviderModels, type ModelInfo, type ProviderModels } from '../model/registry.js';
import { connectMcpServers, type McpConnection, type McpStatus } from '../mcp/client.js';
import { bridgeMcpTools } from '../mcp/bridge.js';
import { PermissionGate } from '../permissions/gate.js';
import { LspManager } from '../lsp/manager.js';
import { createBuiltinTools, TodoStore } from '../tools/index.js';
import {
  createTaskTool,
  runTaskSubagent,
  EXPLORE_PROMPT,
  SUBAGENT_PROMPT,
  type TaskMode,
  type TaskToolDeps,
} from '../tools/task.js';
import { SessionStore, type SessionState } from '../session/store.js';
import { t } from '../i18n/index.js';
import fs from 'node:fs/promises';
import { SkillManager } from '../skills/manager.js';
import { createSkillTool } from '../skills/tool.js';
import { readSkillBody, type SkillCommandInfo, type SkillMeta } from '../skills/discovery.js';
import { substituteArgs } from '../skills/substitute.js';
import { wrapSkillPrompt } from '../skills/invocation.js';
import {
  buildReviewPrompt,
  collectReviewCommits,
  collectReviewSummary,
  collectReviewTargets,
  parseReviewArg,
  type ReviewCommit,
  type ReviewScope,
  type ReviewStartResult,
  type ReviewSummary,
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
  gate: PermissionGate;
  todos: TodoStore;
  /** `/goal` 的目标监管器:发起轮次时经它走,由它决定要不要自动续跑。 */
  goal: GoalController;
  /** LSP 诊断管理器;lsp.enabled: false 时为 undefined。/doctor 读它的运行状态。 */
  lsp?: LspManager;
  mcpStatuses: McpStatus[];
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
   * 远程会话(client-server 模式)下是异步的,调用方一律 await。
   */
  switch: (change: { provider?: string; model?: string; apiKey?: string }) => ResolvedProvider | Promise<ResolvedProvider>;
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
  /** 切换两轴权限(用户显式操作:/approvals、shift+tab)。 */
  setPermissions: (permissions: Permissions) => void;
  /** 进入/退出计划模式。退出即"未批准就放弃",批准走 exit_plan 的回调。 */
  setPlan: (active: boolean) => void;
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
  /**
   * `/review` 二级选择器的数据源(server 侧跑 git:当前分支 + 其余本地分支,
   * 按最近提交排序)。远程侧普通 RPC——快、小、不跑 agent。
   */
  reviewTargets: () => Promise<ReviewTargets>;
  /** `/review` 提交选择器的数据源:最近 N 个提交。远程侧普通即时 RPC。 */
  reviewCommits: () => Promise<ReviewCommit[]>;
  /**
   * 以用户身份跑一轮代码评审(`/review`):权威解析范围 → 收集 git 摘要 →
   * 组稿罐装提示词交给 agent.run(信封复用技能的 `<skill-command>`,回放
   * 据此还原成命令原文)。失败以 reason 代码返回、不抛异常,UI 据此映射
   * 本地化提示。远程侧是 deferred RPC(包 agent.run,可能跑几分钟)。
   */
  startReview: (scopeArg: string, options?: { display?: string }) => Promise<ReviewStartResult>;
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
  ask: PermissionAsker;
  /** 恢复该会话的历史,而不是从头开始。 */
  resume?: SessionStore;
  /** 配合 resume:历史与状态载入,但写入一个全新的会话 id(`--fork-session`)。 */
  fork?: boolean;
  /** 跳过 MCP 连接——`-p` 模式在速度更重要时使用。 */
  skipMcp?: boolean;
  onMcpStatus?: (status: McpStatus) => void;
}

export async function bootstrap(options: BootstrapOptions): Promise<Session> {
  const { root, loaded, ask } = options;
  const config = loaded.config;
  let provider = loaded.provider;

  const bus = new EventBus();
  const todos = new TodoStore();

  // 会话状态快照:todos + 会话级授权规则 + 当前两轴权限。gate/store 在下方
  // 才创建,闭包按绑定取值,实际调用时都已就绪。
  const snapshotState = (): SessionState => {
    // 只有一种情况不把权限写进会话记录:permsPromoted——read-only+never 下批准
    // 方案被提升到 ask,那是"这一次批准"换来的放宽,不是用户选的档位,不该活到
    // 下一次 `mojocode -c`。用户显式切的档位一律留存,full-access 也不例外。
    //
    // 计划模式**不**在此列:SessionState 根本不存 plan 标志,恢复时不可能停在
    // 计划模式;而进入计划模式时两轴保持不变(setPlan 原样传当前组合),所以
    // 这里存的就是进入前的选择。漏存反而会抹掉它——状态记录是整份替换,
    // shift+tab 切到 auto 再切进 plan,记录就被重写成没有权限,恢复这个会话时
    // 用户的选择凭空消失(项目配置里存的是"这个工作区最后一次选的档",会话
    // 记录存的是"这个会话当时的档",两者各管各的)。
    const perms: Permissions = { sandbox: config.sandbox, approval: config.approval };
    const omit = permsPromoted;
    const activeGoal = goal.state;
    // allowNet 与 goal 同一手法:空时整个字段不出现,老会话的状态记录
    // JSON 保持一字不差,脏检查不会平白多写一条记录。
    const { allowNet, ...sessionRules } = gate.exportSessionRules();
    return {
      todos: todos.get(),
      ...sessionRules,
      ...(allowNet.length > 0 ? { allowNet } : {}),
      ...(omit ? {} : { sandbox: perms.sandbox, approval: perms.approval }),
      // 无目标时整个字段不出现:JSON.stringify 的结果与加这个功能之前一字
      // 不差,saveState 的脏检查因此不会为老会话平白多写一条 state 记录。
      ...(activeGoal ? { goal: { condition: activeGoal.condition } } : {}),
    };
  };
  const persistState = (): void => {
    void store.saveState(snapshotState()).catch(() => {
      // 状态是尽力而为的附属信息,失败不打扰用户(消息保存失败才提示)。
    });
  };

  const gate = new PermissionGate({
    root,
    permissions: { sandbox: config.sandbox, approval: config.approval },
    plan: config.plan,
    rules: config.permissions,
    ask,
    bus,
    onRulesChanged: () => persistState(),
  });

  // 中断后仍排在队列里的授权询问要一并作废——并行工具调用会让多个请求
  // 依次排队,否则用户得为一个已经死掉的轮次挨个消确认框。
  bus.on((event) => {
    if (event.type === 'aborted') gate.cancelPending();
    else if (event.type === 'turn-start') {
      gate.resumePending();
      // 轮前刷新技能:模型在本轮看到的 L1 列表最多旧 15s(TTL);digest
      // 变了就地换 skill 工具,下一次 stream 生效。
      void skillManager
        .list()
        .then(() => syncSkillTool())
        .catch(() => {});
    }
  });

  /**
   * 方案获批后要还原的两轴组合——即进入计划模式之前的那套。planReturnFor
   * 决定要不要提升(只有 read-only+never 会提升到 ask,批准才有意义)。
   * `--plan` 直接启动时没有这次转换,归宿取配置里的两轴(即启动时的组合)。
   */
  let planReturn = planReturnFor({ sandbox: config.sandbox, approval: config.approval });
  /**
   * 当前组合是否由"批准方案"提升而来。为真时不写进会话记录,见 snapshotState。
   * 任何显式的权限切换都会把它清掉——那时是用户自己的选择,理应留存。
   */
  let permsPromoted = false;

  // 诊断回喂:惰性拉起 LSP 服务器,write/edit 后把错误/警告随工具结果给模型。
  const lsp = config.lsp.enabled ? new LspManager(root, config.lsp) : undefined;

  /**
   * 技能激活的会话态。asked 记住已经问过 allowed-tools 的技能(同会话只问
   * 一次,**拒绝也记住**——反复弹同一个框比放弃预授权更烦人);extraReadRoots
   * 是已激活技能目录的 realpath 集合(read/glob 的只读扩根);pendingUserSkills
   * 是本轮用户斜杠点名的技能(skill 工具据此放行 disable-model-invocation)。
   */
  const skillActivation = {
    asked: new Set<string>(),
    extraReadRoots: new Set<string>(),
    pendingUserSkills: new Set<string>(),
  };
  /** `/new`、`/resume` 时清空:激活是对话级状态,不跨对话漂移。 */
  const resetSkillActivation = (): void => {
    skillActivation.asked.clear();
    skillActivation.extraReadRoots.clear();
    skillActivation.pendingUserSkills.clear();
  };

  const toolContext = {
    root,
    gate,
    bus,
    rules: config.permissions,
    readFiles: new Set<string>(),
    lsp,
    // 惰性 getter,理由同下方 GoalController 的 evaluatorModel:config 会被
    // switchProvider/applyPermissions 就地修改,现取现算才拿到当下的值。
    searchBackend: () => resolveSearchBackend(config, process.env),
    // applyPermissions 在下方才定义,但这个回调要到工具执行时才被调用,那时
    // 早已就绪——与上面 snapshotState 闭包 gate/store 是同一手法。
    exitPlanMode: (): Permissions => {
      applyPermissions(planReturn.perms, { plan: false, promoted: planReturn.promoted });
      return planReturn.perms;
    },
    extraReadRoots: () => [...skillActivation.extraReadRoots],
  };

  const skillManager = new SkillManager({ root });

  /**
   * 激活技能:目录 realpath 进只读扩根;主 agent 且带 allowed-tools 时做
   * 一次性确认(拒绝也记住,同会话不纠缠)。子 agent 激活只扩根不确认——
   * explore 子代理连确认框都不该弹,这是它进 explore 白名单的前提。
   * 计划模式跳过预授权:方案未批就先放行写规则是自相矛盾的,硬拒仍兜底。
   */
  const activateSkill = async (meta: SkillMeta, opts?: { subagent?: boolean }): Promise<void> => {
    try {
      skillActivation.extraReadRoots.add(await fs.realpath(meta.dir));
    } catch {
      // 目录已消失:不扩根,正文读取会给出具体报错。
    }
    if (opts?.subagent || !meta.allowedTools?.length || config.plan) return;
    if (skillActivation.asked.has(meta.name)) return;
    // 先记后问:确认框是异步的,同一轮里并发触发同一个技能会连弹两次。
    skillActivation.asked.add(meta.name);
    await gate.confirmSessionRules(meta.name, meta.allowedTools);
  };

  // env 可变:refreshEnvironment(`/init` 写完 AGENTS.md 后)会整体换新。
  // 技能初扫并入同一批:tools 组装(下方)读 skillManager.current() 决定
  // 要不要注册 skill 工具。扫描失败按"没有技能"处理,不拦启动。
  let [env, mcp] = await Promise.all([
    gatherEnvironment(root),
    options.skipMcp
      ? Promise.resolve({ connections: [] as McpConnection[], statuses: [] as McpStatus[] })
      : connectMcpServers(config.mcpServers, options.onMcpStatus),
    skillManager.list().catch(() => undefined),
  ]);

  /**
   * 子 agent 的工具集:每次现建一份 builtin(共享同一个 toolContext,权限门、
   * readFiles、搜索后端全都同一套),去掉主会话状态类工具——todo 会抢主界面
   * 的任务面板,exit_plan 属于主 agent 的计划审批;task 本身不在 builtin 里,
   * 递归天然只放一层。现建而非复用 tools:web_search 注册与否取决于当时
   * 能不能解析出搜索后端。
   */
  const subagentTools = (mode: TaskMode): ToolSet => {
    // 自己的 readFiles:护栏要保证"改的那个 agent 亲眼看过内容",共享会让
    // 主 agent 凭子 agent 的阅读就能编辑自己从没读过的文件。每次调用现建
    // 一份,连续两个子任务之间也不串。
    const subContext = { ...toolContext, readFiles: new Set<string>(), subagent: true };
    const all: ToolSet = {
      ...createBuiltinTools(subContext, todos),
      ...bridgeMcpTools(mcp.connections, gate, { subagent: true }),
      // 子 agent 的 skill 工具:激活只扩根、不弹确认,fork 退化为内联返回
      // 正文(runFork 不注入),守住"递归只放一层"。
      ...(hasModelSkills() ? { skill: skillToolFor(true) } : {}),
    };
    const { todo: _todo, exit_plan: _exitPlan, ...general } = all;
    if (mode !== 'explore') return general;
    // explore:纯调研,只留只读工具。MCP 工具不透明,可能有副作用,一并去掉。
    // skill 留下是安全的:它只返回文本、登记只读扩根,子 agent 激活不确认,
    // 所以永远不会在 explore 里弹出确认框——这个耦合破了就得把它移出白名单。
    const picked: ToolSet = {};
    for (const name of ['read', 'glob', 'grep', 'web_fetch', 'web_search', 'skill']) {
      const t_ = (general as ToolSet)[name];
      if (t_) picked[name] = t_;
    }
    return picked;
  };

  /**
   * 子 agent 的系统提示词。plan 恒传 false——计划模式那段要求"最终必须调
   * exit_plan",而子 agent 没有这个工具,照抄只会让它对着不存在的工具空转;
   * 写入约束本身由共享的权限门兜底,这里只需一句说明。
   */
  const subagentSystemPrompt = (mode: TaskMode): string => {
    const base = buildSystemPrompt(
      env,
      {
        permissions: { sandbox: config.sandbox, approval: config.approval },
        plan: false,
        webSearch: webSearchAvailable,
      },
      config.systemPromptAppend,
    );
    // 计划模式下写入会被门禁硬拒。提前说清楚,免得它把步数耗在"试一次被拒
    // →再试一次"上;门禁的拒绝理由也针对子 agent 单独措辞(见 hardStopReason)。
    const planNote = config.plan
      ? '\n\nNote: the session is in plan mode — file edits and state-changing commands are ' +
        'refused. Research and report only. You have no exit_plan tool; never try to call it.'
      : '';
    const modeNote = mode === 'explore' ? `\n\n${EXPLORE_PROMPT}` : '';
    return `${base}\n\n${SUBAGENT_PROMPT}${modeNote}${planNote}`;
  };

  /** 子 agent 的 provider:惰性取,taskModel 覆盖模型 id(未配置则原样)。 */
  const taskProvider = (): ResolvedProvider =>
    config.taskModel ? { ...provider, model: config.taskModel } : provider;

  /** task 工具与 skill 工具的 fork 通道共用同一份子代理依赖。 */
  const taskDeps: TaskToolDeps = {
    config,
    bus,
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
      activate: (meta) => activateSkill(meta, { subagent }),
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
    ...createBuiltinTools(toolContext, todos),
    ...bridgeMcpTools(mcp.connections, gate),
    task: createTaskTool(taskDeps),
    // 一个 model-invocable 技能都没有时干脆不注册:空列表的工具纯占前缀。
    ...(hasModelSkills() ? { skill: skillToolFor(false) } : {}),
  };
  // 系统提示词按注册结果如实陈述——说了不存在的工具,模型就会去调它。
  const webSearchAvailable = 'web_search' in tools;

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
    systemPrompt: buildSystemPrompt(
      env,
      {
        permissions: { sandbox: config.sandbox, approval: config.approval },
        plan: config.plan,
        webSearch: webSearchAvailable,
      },
      config.systemPromptAppend,
    ),
    tools,
    bus,
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

  const goal = new GoalController({
    agent,
    bus,
    config,
    // 现取而不是提前建好:`/models`、`/provider` 换过之后 provider 是个新对象,
    // 提前建的模型会一直打向已经被换掉的那个服务端。createModel 只是本地
    // 构造(registry.ts:13),没有网络往返,每次评估现建一个不值一提。
    evaluatorModel: () =>
      createModel(config.goalModel ? { ...provider, model: config.goalModel } : provider),
    onChange: () => persistState(),
  });

  const restoreState = (state: SessionState): void => {
    todos.set(structuredClone(state.todos));
    gate.setSessionRules(state);
    // else 分支同样重要:从一个带目标的会话 /resume 到不带目标的会话时,
    // 旧目标必须解除,否则它会悄悄接管新会话的轮次。
    if (state.goal?.condition) goal.restore(state.goal.condition);
    else goal.clear();
    // 两轴权限不在此处应用:CLI 启动路径已把它并进配置层;
    // TUI 内 /resume 则由 resumeSession 显式调用 setPermissions。
  };

  if (options.resume) {
    agent.setHistory([...options.resume.messages]);
    restoreState(options.resume.state);
  }

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
    // meta 的 provider/model 现在纯粹是给会话列表看的("这段对话用的什么
    // 模型"),不跟着切就会一直停在创建时的值。
    store.setModel(next.id, next.model);
    return next;
  };

  /**
   * 权限变化的唯一落点。`promoted` 只有 exit_plan 从 read-only+never 提升
   * 上来时为真,它决定这套组合要不要写进会话记录(见 snapshotState)。
   */
  const applyPermissions = (
    permissions: Permissions,
    opts: { plan: boolean; promoted: boolean },
  ): void => {
    // 进入计划模式时记下来路,批准后按它还原。
    if (opts.plan && !config.plan) {
      planReturn = planReturnFor({ sandbox: config.sandbox, approval: config.approval });
    }
    permsPromoted = opts.promoted;
    config.sandbox = permissions.sandbox;
    config.approval = permissions.approval;
    config.plan = opts.plan;
    gate.setPermissions(permissions);
    gate.setPlanMode(opts.plan);
    agent.updateSystemPrompt(
      buildSystemPrompt(
        env,
        { permissions, plan: opts.plan, webSearch: webSearchAvailable },
        config.systemPromptAppend,
      ),
    );
    persistState();
    // 权限也可能由 exit_plan 在工具侧切换,渲染层只能靠这条事件跟上。
    bus.emit({ type: 'permission-change', permissions, plan: opts.plan });
  };

  /** 用户显式切换两轴:一律留存(写会话记录;项目配置由 UI 侧的 savePermissions 落盘),并退出计划模式。 */
  const setPermissions = (permissions: Permissions): void =>
    applyPermissions(permissions, { plan: false, promoted: false });

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
    // 上一轮被 esc 中断后确认队列处于作废态,轮前的 allowed-tools 确认会被
    // 静默自动拒(askSerialized 的 pendingCancelled 分支)。先显式复位。
    gate.resumePending();
    await skillManager.list().catch(() => {});
    syncSkillTool();
    const meta = skillManager.find(name);
    if (!meta || !meta.userInvocable) {
      throw new Error(`Unknown skill: ${name}`);
    }
    await activateSkill(meta);
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
   * `/review` 的执行侧:收集 git 摘要 → 失败以 reason 返回(英文 git 错误串
   * 不直接怼进时间线,与 runSkill 的差异之一)→ 组稿提示词跑一轮。与
   * runSkill 的另一点差异:不需要 gate.resumePending()(评审没有轮前的
   * allowed-tools 确认,turn-start 的总线监听已统一复位)。display 缺省按
   * `/review <范围>` 重组——picker 路径没有"用户原文"可用,直打路径与原文
   * 等价。曾与 /simplify 共用一个参数化执行体,两阶段化后各只剩一份差异,
   * 单调用方的包装层即拆除。
   */
  const startReview = async (
    scopeArg: string,
    options?: { display?: string },
  ): Promise<ReviewStartResult> => {
    const scope = parseReviewArg(scopeArg);
    if (!scope) return { ok: false, reason: 'bad-arg' };
    const collected = await collectReviewSummary(root, scope);
    if (!collected.ok) return collected;
    const display = options?.display ?? `/review ${scopeArg}`;
    await agent.run(wrapSkillPrompt(display, buildReviewPrompt(scope, collected.summary)), {
      display,
    });
    return { ok: true };
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

  /**
   * 进入/退出计划模式,两轴始终不动。
   *
   * 退出 = 未批准就放弃,所以绝不能走 planReturn.perms:从 read-only+never
   * 进来时那已经是被提升过的 ask(提升只有"用户真的批准了方案"才配得上),
   * 放弃却拿到可写权限、还会被记进会话文件。进入时两轴原样保留,当前值
   * 本来就是进入前的组合,原样传回即可。
   */
  const setPlan = (active: boolean): void => {
    const current: Permissions = { sandbox: config.sandbox, approval: config.approval };
    applyPermissions(current, { plan: active, promoted: false });
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
    gate,
    todos,
    goal,
    lsp,
    mcpStatuses: mcp.statuses,
    get store() {
      return store;
    },
    newSession: async () => {
      store = await SessionStore.create({ root, provider: provider.id, model: provider.model });
      agent.clear();
      todos.set([]);
      goal.clear();
      resetSkillActivation();
      persistState();
      return store;
    },
    resumeSession: async (idOrPrefix: string) => {
      const id = await SessionStore.resolveId(idOrPrefix, { root });
      const opened = await SessionStore.open(id);
      store = opened;
      // 与 setSessionRules 的替换语义同理:上一段对话激活的技能(扩根、
      // allowed-tools 确认)不能漂进另一段对话。
      resetSkillActivation();
      // 换的是另一段对话:累计用量一并归零(见 setHistory 的注释)。
      agent.setHistory([...opened.messages], { resetSpend: true });
      restoreState(opened.state);
      if (opened.state.sandbox && opened.state.approval) {
        setPermissions({ sandbox: opened.state.sandbox, approval: opened.state.approval });
      }
      // 刻意不切回会话记录的 provider/model:恢复的是对话内容,模型始终
      // 沿用当前正在用的那一个。反过来把 meta 更新成当前模型,列表里那一行
      // 才不会继续宣称一个这段对话往后都不会再用的模型。
      opened.setModel(provider.id, provider.model);
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
      return store;
    },
    switch: switchProvider,
    setPermissions,
    setPlan,
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
    listModels: () => listModels(provider),
    doctor: ({ offline }) =>
      runDoctor({
        root,
        config,
        mcpStatuses: mcp.statuses,
        // 会话内已拉起的服务器直接采信状态;没拉起过的由 doctor 做一次真握手
        // 探测(探完即杀)。
        lspStatuses: lsp?.statuses(),
        offline,
      }),
    refreshEnvironment: async () => {
      env = await gatherEnvironment(root);
      agent.updateSystemPrompt(
        buildSystemPrompt(
          env,
          {
            permissions: { sandbox: config.sandbox, approval: config.approval },
            plan: config.plan,
            webSearch: webSearchAvailable,
          },
          config.systemPromptAppend,
        ),
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
    reviewTargets: () => collectReviewTargets(root),
    reviewCommits: () => collectReviewCommits(root),
    startReview,
    startSimplify,
    dispose: async () => {
      goal.dispose();
      await Promise.all([...mcp.connections.map((c) => c.close()), lsp?.dispose()]);
    },
  };
}
