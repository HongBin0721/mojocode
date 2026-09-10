import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';
import type { ToolScope } from '../src/core/extension.js';
import type { McpConnection, McpStatus } from '../src/mcp/client.js';
import { recordingExtensionApi, type RecordingHost } from './support/extension-api.js';
import { t } from '../src/i18n/index.js';

/**
 * MCP 扩展:连接的**非阻塞**语义与随之而来的三条不变量——首轮不抢跑
 * (turn_start 等连接收尾)、关会话时连接还在路上也不留孤儿进程、工具连上
 * 之后才注册进来。这些原来都住在 bootstrap 里,是这次搬家最容易接错的部分。
 */

const { mockConnect } = vi.hoisted(() => ({ mockConnect: vi.fn() }));
vi.mock('../src/mcp/client.js', () => ({ connectMcpServers: mockConnect }));

import { mcpExtension, MCP_RUNTIME_KEY } from '../src/extensions/mcp/index.js';

/** 一个假连接:带一个工具,close 可观察。 */
function fakeConnection(name: string, toolName = 'search') {
  const close = vi.fn(async () => {});
  const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'result text' }] }));
  const connection = {
    name,
    client: { callTool },
    tools: [{ name: toolName, description: `${toolName} via ${name}`, inputSchema: { type: 'object' } }],
    close,
  } as unknown as McpConnection;
  return { connection, close, callTool };
}

interface Host extends RecordingHost {
  runtime: Map<string, () => unknown>;
}

function makeHost(mcpServers: Record<string, unknown> = { local: { type: 'stdio', command: 'x' } }): Host {
  const runtime = new Map<string, () => unknown>();
  const recorded = recordingExtensionApi({
    id: 'mcp',
    publishRuntime: (key, get) => runtime.set(key, get),
    config: { mcpServers } as never,
  });
  const host: Host = { ...recorded, runtime };
  mcpExtension.setup(recorded.api);
  return host;
}

const MAIN: ToolScope = { subagent: false };

beforeEach(() => {
  mockConnect.mockReset();
});

describe('MCP 扩展', () => {
  it('连接是非阻塞的:setup 立即返回,工具在连上之后才注册进来', async () => {
    let settle!: (value: { connections: McpConnection[] }) => void;
    mockConnect.mockImplementation(
      () => new Promise((resolve) => (settle = resolve as typeof settle)),
    );
    const host = makeHost();
    // setup 已经返回,而连接还挂着:工具表此刻是空的。
    expect(host.tools.size).toBe(0);

    const { connection } = fakeConnection('local');
    settle({ connections: [connection] });
    await vi.waitFor(() => expect(host.tools.size).toBe(1));
    expect([...host.tools.keys()]).toEqual(['mcp__local__search']);
  });

  it('首轮不抢跑:turn_start 等连接收尾', async () => {
    let settle!: (value: { connections: McpConnection[] }) => void;
    mockConnect.mockImplementation(
      () => new Promise((resolve) => (settle = resolve as typeof settle)),
    );
    const host = makeHost();

    let turnStarted = false;
    const turn = host.hooks
      .turnStart({ userText: 'hi', subagent: false })
      .then(() => (turnStarted = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(turnStarted).toBe(false); // 还卡在连接上

    settle({ connections: [fakeConnection('local').connection] });
    await turn;
    expect(turnStarted).toBe(true);
    // 门放行时工具已经注册好了:首轮的工具集与旧的阻塞式启动一致。
    expect(host.tools.size).toBe(1);
  });

  it('连接失败经 bus notice 呈现,不写 stderr', async () => {
    mockConnect.mockImplementation(
      async (_servers: unknown, onStatus?: (s: McpStatus) => void) => {
        onStatus?.({ name: 'broken', connected: false, toolCount: 0, error: 'spawn failed' });
        return { connections: [] };
      },
    );
    const host = makeHost();
    await host.hooks.turnStart({ userText: 'hi', subagent: false });
    expect(host.notices).toEqual([
      { level: 'warn', message: t('cli.mcpFailed', { name: 'broken', error: 'spawn failed' }) },
    ]);
  });

  it('工具调用打到 MCP server;结果压平成文本', async () => {
    const { connection, callTool } = fakeConnection('local');
    mockConnect.mockResolvedValue({ connections: [connection] });
    const host = makeHost();
    await host.hooks.turnStart({ userText: 'hi', subagent: false });

    const factory = host.tools.get('mcp__local__search')!;
    const tool = factory(MAIN) as Tool & { execute: (i: unknown, o: unknown) => Promise<unknown> };
    const out = await tool.execute({ q: 'x' }, { toolCallId: 'c1' });

    expect(callTool).toHaveBeenCalledWith({ name: 'search', arguments: { q: 'x' } });
    expect(out).toEqual({ content: 'result text' });
  });


  it('explore 子 agent 拿不到 MCP 工具(不透明、可能有副作用);general 子 agent 拿得到', async () => {
    mockConnect.mockResolvedValue({ connections: [fakeConnection('local').connection] });
    const host = makeHost();
    await host.hooks.turnStart({ userText: 'hi', subagent: false });
    const factory = host.tools.get('mcp__local__search')!;

    expect(factory({ subagent: true, mode: 'explore' })).toBeUndefined();
    expect(factory({ subagent: true, mode: 'general' })).toBeDefined();
    expect(factory(MAIN)).toBeDefined();
  });


  it('两个 server 暴露同名工具时各自带命名空间,不互相顶掉', async () => {
    mockConnect.mockResolvedValue({
      connections: [fakeConnection('a').connection, fakeConnection('b').connection],
    });
    const host = makeHost();
    await host.hooks.turnStart({ userText: 'hi', subagent: false });
    expect([...host.tools.keys()].sort()).toEqual(['mcp__a__search', 'mcp__b__search']);
  });

  it('关会话:关掉全部连接', async () => {
    const a = fakeConnection('a');
    mockConnect.mockResolvedValue({ connections: [a.connection] });
    const host = makeHost();
    await host.hooks.turnStart({ userText: 'hi', subagent: false });
    expect(host.tools.size).toBe(1);

    // 断言的是**子进程被关掉**。工具表不必注销:dispose 只在进程收尾时跑,
    // 那张表马上就跟着进程一起没了。
    await host.hooks.sessionShutdown();
    expect(a.close).toHaveBeenCalledTimes(1);
  });

  it('连接还在路上时会话就关了:落地的连接立刻关掉,不留 stdio 孤儿进程', async () => {
    let settle!: (value: { connections: McpConnection[] }) => void;
    mockConnect.mockImplementation(
      () => new Promise((resolve) => (settle = resolve as typeof settle)),
    );
    const host = makeHost();
    const late = fakeConnection('late');

    const shutdown = host.hooks.sessionShutdown();
    settle({ connections: [late.connection] });
    await shutdown;

    expect(late.close).toHaveBeenCalledTimes(1);
    // 迟到的连接不注册工具:会话已经没了。
    expect(host.tools.size).toBe(0);
  });

  it('publishRuntime 给的是连接收尾后的完整状态(半满的会让 doctor 误报 fail)', async () => {
    let settle!: (value: { connections: McpConnection[] }) => void;
    mockConnect.mockImplementation(
      async (_servers: unknown, onStatus?: (s: McpStatus) => void) => {
        onStatus?.({ name: 'first', connected: true, toolCount: 1 });
        return new Promise((resolve) => (settle = resolve as typeof settle));
      },
    );
    const host = makeHost();
    const pending = host.runtime.get(MCP_RUNTIME_KEY)!() as Promise<McpStatus[]>;

    let resolved = false;
    void pending.then(() => (resolved = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false); // 半满时不给

    settle({ connections: [] });
    expect(await pending).toEqual([{ name: 'first', connected: true, toolCount: 1 }]);
  });

  it('/mcp 列出连接状态;没有 server 时说没有', async () => {
    mockConnect.mockResolvedValue({ connections: [] });
    const empty = makeHost({});
    await empty.commands.get('mcp')!.handler('');
    expect(empty.notices.at(-1)).toEqual({ level: 'info', message: t('notice.mcpNone') });

    mockConnect.mockImplementation(
      async (_servers: unknown, onStatus?: (s: McpStatus) => void) => {
        onStatus?.({ name: 'ok', connected: true, toolCount: 3 });
        onStatus?.({ name: 'bad', connected: false, toolCount: 0, error: 'boom' });
        return { connections: [] };
      },
    );
    const host = makeHost();
    await host.commands.get('mcp')!.handler('');
    const message = host.notices.at(-1)!.message;
    expect(message).toContain('ok');
    expect(message).toContain(t('notice.mcpTools', { n: 3 }));
    expect(message).toContain('bad');
    expect(message).toContain('boom');
  });
});
