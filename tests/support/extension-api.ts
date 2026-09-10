/**
 * 扩展测试用的假 `ExtensionAPI`:给出全部成员的空实现,测试只覆盖自己关心的
 * 那几个。
 *
 * 直接写对象字面量也行,但每加一个 API 成员,每个扩展的测试都要补一遍空实现
 * ——那正是这个 helper 存在的理由(与 tests/support/extensions.ts 之于假
 * session 同理)。**不要**把它写成 `as unknown as ExtensionAPI`:那样新成员
 * 在测试里就成了运行期才炸的 undefined。
 */

import {
  ExtensionEvents,
  type ExtensionAPI,
  type ExtensionCommand,
  type ExtensionToolDefinition,
  type ExtensionToolFactory,
} from '../../src/core/extension.js';
import type { SessionCustomRecord } from '../../src/session/store.js';
import type { Config } from '../../src/config/schema.js';
import { HookRegistry, noopExtensionContext } from '../../src/core/hooks.js';

export function fakeExtensionApi(overrides: Partial<ExtensionAPI> = {}): ExtensionAPI {
  const ctx = noopExtensionContext();
  return {
    id: 'test',
    root: '/tmp/workspace',
    on: () => () => {},
    onEvent: () => () => {},
    events: new ExtensionEvents(),
    ui: ctx.ui,
    hasUI: false,
    ctx,
    mode: 'print',
    waitForIdle: async () => {},
    newSession: async () => {},
    fork: async () => ({ id: '' }),
    switchSession: async () => {},
    registerCommand: () => {},
    getCommands: () => [],
    registerShortcut: () => () => {},
    sendMessage: async () => {},
    registerMessageRenderer: () => {},
    setStatus: () => {},
    setState: () => {},
    notify: () => {},
    publishRuntime: () => {},
    registerTool: () => {},
    unregisterTool: () => {},
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    run: async () => {},
    followUp: () => {},
    isRunning: () => false,
    abort: () => {},
    history: () => [],
    compact: async () => {},
    getContextUsage: () => ({ used: 0, window: 0, percent: 0 }),
    appendEntry: async () => {},
    entries: () => [],
    getSessionName: () => '',
    setSessionName: async () => {},
    config: {} as Config,
    model: () => ({}) as never,
    getModel: () => ({ provider: 'test', model: 'test-model' }),
    setModel: async () => {},
    getThinkingLevel: () => 'auto',
    setThinkingLevel: async () => {},
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    ...overrides,
  };
}

/** `recordingExtensionApi` 交回的宿主侧观察点。 */
export interface RecordingHost {
  api: ExtensionAPI;
  /** 扩展注册的钩子:测试直接 `hooks.toolResult(...)` 之类触发。 */
  hooks: HookRegistry;
  /** 扩展注册的工具工厂(name → factory)。 */
  tools: Map<string, ExtensionToolFactory>;
  /** 扩展注册的命令(name → command)。 */
  commands: Map<string, ExtensionCommand>;
  /** 扩展经 setState 发布的结构化状态。 */
  state: Map<string, unknown>;
  /**
   * setStatus 的**调用流水**(每次一条,undefined 是清除)。刻意是数组而不是
   * "当前值":引用稳定,`{ ...host }` 复制出去仍然跟着变——一个会被快照掉的
   * getter 正是这次清理要消灭的形状。当前值取 `statuses.at(-1)`。
   */
  statuses: Array<{ text: string | undefined; since?: number }>;
  /** 扩展经 notify 发出的提示。 */
  notices: Array<{ level: 'info' | 'warn'; message: string }>;
  /** 会话的 custom 记录:appendEntry 追加,entries(type) 按类型读。 */
  entries: SessionCustomRecord[];
}

/**
 * 会**记录**的假 ExtensionAPI:钩子、工具、命令、状态、提示、custom 记录都
 * 落进可断言的容器里。
 *
 * `fakeExtensionApi` 给的是空实现(测试只覆盖自己关心的那几个);但每个扩展
 * 的测试真正需要的是同一套录制实现,于是那四五行曾在六个测试文件里各写一
 * 遍(`on: (name, handler) => hooks.on(name, handler)` 出现过七次),连
 * `notify` 记什么形状都各不相同。ExtensionAPI 上再加一个"宿主要记录"的成员
 * 时,改这一处就够了。
 */
export function recordingExtensionApi(
  overrides: Partial<ExtensionAPI> = {},
  options: { entries?: SessionCustomRecord[] } = {},
): RecordingHost {
  const hooks = new HookRegistry();
  const tools = new Map<string, ExtensionToolFactory>();
  const commands = new Map<string, ExtensionCommand>();
  const state = new Map<string, unknown>();
  const notices: Array<{ level: 'info' | 'warn'; message: string }> = [];
  const entries: SessionCustomRecord[] = options.entries ?? [];
  const statuses: RecordingHost['statuses'] = [];
  const api = fakeExtensionApi({
    on: (name, handler) => hooks.on(name, handler),
    // 两种形状都记成工厂:Pi 定义对象这里不适配(那是 bootstrap 的事),只记名字。
    registerTool: (nameOrDefinition: string | ExtensionToolDefinition, factory?: ExtensionToolFactory) => {
      if (typeof nameOrDefinition === 'object') tools.set(nameOrDefinition.name, () => undefined);
      else tools.set(nameOrDefinition, factory!);
    },
    unregisterTool: (name) => tools.delete(name),
    registerCommand: (name, command) => commands.set(name, command),
    setState: (key, value) => {
      if (value === undefined) state.delete(key);
      else state.set(key, value);
    },
    setStatus: (text, opts) => {
      statuses.push({ text, ...(opts?.since !== undefined ? { since: opts.since } : {}) });
    },
    notify: (level, message) => notices.push({ level, message }),
    appendEntry: async (type, data) => {
      entries.push({ type, data, at: new Date().toISOString() });
    },
    entries: (type) => entries.filter((entry) => entry.type === type),
    ...overrides,
  });
  return { api, hooks, tools, commands, state, statuses, notices, entries };
}
