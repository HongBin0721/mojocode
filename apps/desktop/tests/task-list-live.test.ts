/**
 * 任务列表实时性(回归:新会话提问后左侧任务列表不更新):
 * 真 startServer + 真 connectRemote + 真 TaskManager,只有 Session 是手工假对象
 * (与 tests/server.test.ts 同构)。覆盖两条链:run RPC 分发的乐观即时出现,
 * 以及 SSE state 帧驱动的 historyLength/isRunning 跟进。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '@core/events';
import { connectRemote } from '@core/remote';
import { startServer, createPermissionBroker } from '../../../src/server/serve.js';
import { createTaskManager, type TaskSummaryMeta } from '../src/main/task-manager.js';
import type { ServerRuntime } from '../src/main/resolve-runtime.js';
import { IPC_CHANNELS } from '../src/shared/ipc.js';
import type { TaskSummary } from '../src/shared/ipc.js';

const runtime: ServerRuntime = { nodeBin: 'node', cliJs: '/fake/cli.js', runAsNode: false };

function fakeServerSession() {
  const bus = new EventBus();
  let history: Array<{ role: string; content: string }> = [];
  let running = false;
  const session = {
    root: '/w',
    config: { providers: {}, search: {}, mcpServers: {}, permissions: {} },
    provider: { id: 'kimi', model: 'm', contextWindow: 100_000 },
    bus,
    agent: {
      get isRunning() {
        return running;
      },
      isCompacting: false,
      get history() {
        return history;
      },
      contextUsage: undefined,
      run: vi.fn(async () => {}),
      abort: vi.fn(),
    },
    gate: { setAsker: vi.fn() },
    todos: { get: () => [], subscribe: () => () => {} },
    goal: { active: false, busy: false, state: undefined, snapshot: () => undefined },
    mcpStatuses: [],
    store: {
      id: 'session-0001',
      get messages() {
        return history;
      },
      get displayMessages() {
        return history;
      },
    },
    skills: [],
    skillsChanged: () => () => {},
    changedFiles: [],
    dispose: vi.fn(async () => {}),
  };
  return {
    session,
    bus,
    startTurn(userText: string) {
      running = true;
      history = [{ role: 'user', content: userText }];
      bus.emit({ type: 'turn-start', userText } as never);
    },
    endTurn() {
      running = false;
      history = [...history, { role: 'assistant', content: 'done' }];
      bus.emit({ type: 'turn-end' } as never);
    },
  };
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

describe('首问后任务列表更新(真实 server/remote 链路)', () => {
  it('turn-start 后 tasks 推送应带 messageCount ≥ 1', async () => {
    const world = fakeServerSession();
    const broker = createPermissionBroker();
    const server = await startServer({ session: world.session as never, broker });
    cleanups.push(() => server.close());

    const metas: TaskSummaryMeta[] = [
      {
        id: 'session-0001',
        root: '/w',
        provider: 'kimi',
        model: 'm',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        title: '',
        messageCount: 0,
      },
    ];
    const sends: Array<{ channel: string; args: unknown[] }> = [];
    const manager = createTaskManager({
      runtime,
      target: { send: (channel, ...args) => sends.push({ channel, args }) },
      spawnServer: async () => ({
        url: server.url,
        token: server.token,
        waitExit: async () => {},
      }),
      connect: (opts) => connectRemote(opts),
      listSessions: async () => metas,
    });
    cleanups.push(() => manager.disposeAll());

    await manager.createTask({ root: '/w' });
    const lastRows = () =>
      sends.filter((e) => e.channel === IPC_CHANNELS.tasks).at(-1)?.args[0] as
        | TaskSummary[]
        | undefined;
    expect(lastRows()?.[0]).toMatchObject({ id: 'session-0001', messageCount: 0 });

    // 首问经真实 RPC 分发:乐观置位,不等任何 SSE 帧就重推(发送即出现)。
    await manager.dispatchRpc({ kind: 'run', text: '第一条消息' });
    await waitFor(() => (lastRows()?.[0]?.messageCount ?? 0) >= 1);
    expect(lastRows()?.[0]).toMatchObject({ messageCount: 1, title: '第一条消息' });

    // server 侧真的开跑:isRunning 翻转 + 用户消息进内存历史 → SSE state 帧跟进。
    world.startTurn('第一条消息');
    await waitFor(() => lastRows()?.[0]?.isRunning === true);

    world.endTurn();
    await waitFor(() => lastRows()?.[0]?.isRunning === false);
  }, 10_000);
});
