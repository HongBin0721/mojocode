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
import { SessionStore } from '../session/store.js';
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
  /** 会话中途切换模型和/或 provider;返回新解析的 provider。 */
  switch: (change: { provider?: string; model?: string }) => ResolvedProvider;
  setMode: (mode: PermissionMode) => void;
  dispose: () => Promise<void>;
}

export interface BootstrapOptions {
  root: string;
  loaded: LoadedConfig;
  ask: PermissionAsker;
  /** 恢复该会话的历史,而不是从头开始。 */
  resume?: SessionStore;
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

  const gate = new PermissionGate({
    root,
    mode: config.permissionMode,
    rules: config.permissions,
    ask,
    bus,
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

  const store =
    options.resume ?? (await SessionStore.create({ root, provider: provider.id, model: provider.model }));

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
    },
  });

  if (options.resume) agent.setHistory([...options.resume.messages]);

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
    store,
    switch: ({ provider: providerId, model }) => {
      const next = resolveProvider({
        ...config,
        provider: providerId ?? config.provider,
        // 单独的 `/model x` 保留当前 provider;不带模型切换 provider 时,
        // 必须回退到该 provider 的默认模型,而不是沿用旧的模型 id。
        model: model ?? (providerId ? undefined : config.model),
      });
      config.provider = next.id;
      config.model = next.model;
      provider = next;
      agent.updateModel(createModel(next), next);
      return next;
    },
    setMode: (mode) => {
      config.permissionMode = mode;
      gate.setMode(mode);
      agent.updateSystemPrompt(buildSystemPrompt(env, mode, config.systemPromptAppend));
    },
    dispose: async () => {
      await Promise.all(mcp.connections.map((c) => c.close()));
    },
  };
}
