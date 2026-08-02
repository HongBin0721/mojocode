import type { ModelMessage } from 'ai';
import { Agent } from '../agent/loop.js';
import { buildSystemPrompt, gatherEnvironment, type EnvironmentInfo } from '../agent/prompt.js';
import { resolveProvider, type LoadedConfig, type ResolvedProvider } from '../config/load.js';
import type { Config, PermissionMode } from '../config/schema.js';
import { EventBus, type PermissionAsker } from '../core/events.js';
import { createModel } from '../model/registry.js';
import { connectMcpServers, type McpConnection, type McpStatus } from '../mcp/client.js';
import { bridgeMcpTools } from '../mcp/bridge.js';
import { PermissionGate } from '../permissions/gate.js';
import { createBuiltinTools, TodoStore } from '../tools/index.js';
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
  setMode: (mode: PermissionMode) => void;
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

  // 会话状态快照:todos + 会话级授权规则 + 当前权限模式。gate/store 在下方
  // 才创建,闭包按绑定取值,实际调用时都已就绪。
  const snapshotState = (): SessionState => ({
    todos: todos.get(),
    ...gate.exportSessionRules(),
    // yolo 永远不写进会话记录:它是"就这一次"的临时逃生口,与
    // config/save.ts 的 saveMode 保持同一条规矩——否则 `mojocode --yolo` 一次,
    // 之后每次 `mojocode -c` 都会在命令行没有任何标志的情况下静默全自动放行。
    permissionMode: config.permissionMode === 'yolo' ? undefined : config.permissionMode,
  });
  const persistState = (): void => {
    void store.saveState(snapshotState()).catch(() => {
      // 状态是尽力而为的附属信息,失败不打扰用户(消息保存失败才提示)。
    });
  };

  const gate = new PermissionGate({
    root,
    mode: config.permissionMode,
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

  const toolContext = {
    root,
    gate,
    bus,
    rules: config.permissions,
    readFiles: new Set<string>(),
  };

  const [env, mcp] = await Promise.all([
    gatherEnvironment(root),
    options.skipMcp
      ? Promise.resolve({ connections: [] as McpConnection[], statuses: [] as McpStatus[] })
      : connectMcpServers(config.mcpServers, options.onMcpStatus),
  ]);

  const tools = {
    ...createBuiltinTools(toolContext, todos),
    ...bridgeMcpTools(mcp.connections, gate),
  };

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
    systemPrompt: buildSystemPrompt(env, config.permissionMode, config.systemPromptAppend),
    tools,
    bus,
    onHistoryChange: (messages: ModelMessage[]) => {
      void store.save(messages).catch((err: Error) => {
        bus.emit({ type: 'notice', level: 'warn', message: t('notice.sessionSaveFailed', { message: err.message }) });
      });
      persistState(); // 轮界兜底;脏检查保证状态没变时不产生记录
    },
  });

  const restoreState = (state: SessionState): void => {
    todos.set(structuredClone(state.todos));
    gate.setSessionRules(state);
    // permissionMode 不在此处应用:CLI 启动路径已把它并进配置层;
    // TUI 内 /resume 则由 resumeSession 显式调用 setMode。
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

  const setMode = (mode: PermissionMode): void => {
    config.permissionMode = mode;
    gate.setMode(mode);
    agent.updateSystemPrompt(buildSystemPrompt(env, mode, config.systemPromptAppend));
    persistState();
  };

  return {
    root,
    config,
    get provider() {
      return provider;
    },
    env,
    agent,
    bus,
    gate,
    todos,
    mcpStatuses: mcp.statuses,
    get store() {
      return store;
    },
    newSession: async () => {
      store = await SessionStore.create({ root, provider: provider.id, model: provider.model });
      agent.clear();
      todos.set([]);
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
      if (opened.state.permissionMode) setMode(opened.state.permissionMode);
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
    setMode,
    dispose: async () => {
      await Promise.all(mcp.connections.map((c) => c.close()));
    },
  };
}
