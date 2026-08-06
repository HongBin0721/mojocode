import type { ModelMessage, ToolSet } from 'ai';
import { Agent } from '../agent/loop.js';
import { GoalController } from '../agent/goal.js';
import { buildSystemPrompt, gatherEnvironment, type EnvironmentInfo } from '../agent/prompt.js';
import { resolveProvider, type LoadedConfig, type ResolvedProvider } from '../config/load.js';
import { resolveSearchBackend } from '../config/search.js';
import {
  isEphemeralPermissions,
  planReturnFor,
  type Config,
  type Permissions,
} from '../config/schema.js';
import { EventBus, type PermissionAsker } from '../core/events.js';
import { createModel } from '../model/registry.js';
import { connectMcpServers, type McpConnection, type McpStatus } from '../mcp/client.js';
import { bridgeMcpTools } from '../mcp/bridge.js';
import { PermissionGate } from '../permissions/gate.js';
import { LspManager } from '../lsp/manager.js';
import { createBuiltinTools, TodoStore } from '../tools/index.js';
import { createTaskTool, EXPLORE_PROMPT, SUBAGENT_PROMPT, type TaskMode } from '../tools/task.js';
import { SessionStore, type SessionState } from '../session/store.js';
import { t } from '../i18n/index.js';

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
  /** 会话中途切换模型和/或 provider;返回新解析的 provider。 */
  switch: (change: { provider?: string; model?: string }) => ResolvedProvider;
  /** 切换两轴权限(用户显式操作:/approvals、shift+tab)。 */
  setPermissions: (permissions: Permissions) => void;
  /** 进入/退出计划模式。退出即"未批准就放弃",批准走 exit_plan 的回调。 */
  setPlan: (active: boolean) => void;
  /**
   * 重新收集环境信息并重建系统提示词,让刚写入的 AGENTS.md 不用重启就
   * 生效(`/init` 完成后调用)。
   */
  refreshEnvironment: () => Promise<void>;
  dispose: () => Promise<void>;
}

/**
 * `resumeSession` 里"历史已恢复但 provider/model 切换失败"的标记错误:
 * 调用方据此提示降级信息,而不是把整次恢复当作失败。
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
    // 两种情况不把权限写进会话记录:
    // 1. full-access(danger-full-access)——"就这一次"的逃生口,复活即静默全放行;
    // 2. permsPromoted——read-only+never 下批准方案被提升到 ask,那是"这一次
    //    批准"换来的放宽,不该活到下一次 `mojocode -c`。
    //
    // 计划模式**不**在此列:SessionState 根本不存 plan 标志,恢复时不可能停在
    // 计划模式;而进入计划模式时两轴保持不变(setPlan 原样传当前组合),所以
    // 这里存的就是进入前的选择。漏存反而会抹掉它——状态记录是整份替换,
    // shift+tab 切到 auto 再切进 plan,记录就被重写成没有权限,`mojocode -c`
    // 回到配置默认的 ask,用户的选择凭空消失(shift+tab 刻意不落盘到项目
    // 配置,会话文件是它唯一的留存处)。
    const perms: Permissions = { sandbox: config.sandbox, approval: config.approval };
    const omit = isEphemeralPermissions(perms) || permsPromoted;
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
    else if (event.type === 'turn-start') gate.resumePending();
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
  };

  // env 可变:refreshEnvironment(`/init` 写完 AGENTS.md 后)会整体换新。
  let [env, mcp] = await Promise.all([
    gatherEnvironment(root),
    options.skipMcp
      ? Promise.resolve({ connections: [] as McpConnection[], statuses: [] as McpStatus[] })
      : connectMcpServers(config.mcpServers, options.onMcpStatus),
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
    const { todo: _todo, exit_plan: _exitPlan, ...general } = {
      ...createBuiltinTools(subContext, todos),
      ...bridgeMcpTools(mcp.connections, gate, { subagent: true }),
    };
    if (mode !== 'explore') return general;
    // explore:纯调研,只留只读工具。MCP 工具不透明,可能有副作用,一并去掉。
    const picked: ToolSet = {};
    for (const name of ['read', 'glob', 'grep', 'web_fetch', 'web_search']) {
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

  const tools = {
    ...createBuiltinTools(toolContext, todos),
    ...bridgeMcpTools(mcp.connections, gate),
    task: createTaskTool({
      config,
      bus,
      // 惰性取值:/model、/provider 之后 provider 是新对象,提前建好的模型
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
    }),
  };
  // 系统提示词按注册结果如实陈述——说了不存在的工具,模型就会去调它。
  const webSearchAvailable = 'web_search' in tools;

  // 可变:newSession/resumeSession 会把它换掉,onHistoryChange 始终写当前这个。
  let store: SessionStore;
  if (options.resume && options.fork) {
    // fork:eager 拷贝进新文件,源会话从此不再被写。
    store = await options.resume.fork({ provider: provider.id, model: provider.model });
  } else {
    store =
      options.resume ??
      (await SessionStore.create({ root, provider: provider.id, model: provider.model }));
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

  const goal = new GoalController({
    agent,
    bus,
    config,
    // 现取而不是提前建好:`/model`、`/provider` 换过之后 provider 是个新对象,
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

  const switchProvider = (change: { provider?: string; model?: string }): ResolvedProvider => {
    const next = resolveProvider({
      ...config,
      provider: change.provider ?? config.provider,
      // 单独的 `/model x` 保留当前 provider;不带模型切换 provider 时,
      // 必须回退到该 provider 的默认模型,而不是沿用旧的模型 id。
      model: change.model ?? (change.provider ? undefined : config.model),
    });
    config.provider = next.id;
    config.model = next.model;
    provider = next;
    agent.updateModel(createModel(next), next);
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

  /** 用户显式切换两轴:一律留存(受 isEphemeralPermissions 约束),并退出计划模式。 */
  const setPermissions = (permissions: Permissions): void =>
    applyPermissions(permissions, { plan: false, promoted: false });

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
      persistState();
      return store;
    },
    resumeSession: async (idOrPrefix: string) => {
      const id = await SessionStore.resolveId(idOrPrefix, { root });
      const opened = await SessionStore.open(id);
      store = opened;
      // 换的是另一段对话:累计用量一并归零(见 setHistory 的注释)。
      agent.setHistory([...opened.messages], { resetSpend: true });
      restoreState(opened.state);
      if (opened.state.sandbox && opened.state.approval) {
        setPermissions({ sandbox: opened.state.sandbox, approval: opened.state.approval });
      }
      // 会话身份包含它当时的 provider/model;不同则尽力切换。失败(缺 key、
      // provider 已删)以标记错误抛给调用方,但历史已载入。
      if (opened.meta.provider !== provider.id || opened.meta.model !== provider.model) {
        try {
          switchProvider({ provider: opened.meta.provider, model: opened.meta.model });
        } catch (err) {
          throw new ProviderSwitchError(err as Error);
        }
      }
      return opened;
    },
    switch: switchProvider,
    setPermissions,
    setPlan,
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
    dispose: async () => {
      goal.dispose();
      await Promise.all([...mcp.connections.map((c) => c.close()), lsp?.dispose()]);
    },
  };
}
