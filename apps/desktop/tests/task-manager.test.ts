/**
 * TaskManager 单测:注入假 spawn/connect/listSessions,不起真进程、不 mock
 * electron。覆盖:创建/聚焦/关停、taskId=storeId、RPC 路由与缺任务拒绝、
 * 容量淘汰(运行中豁免)、openTask 的休眠复活参数、tasks 通道推送、
 * disposeAll、switchWorkspaceCompat 守卫。
 */

import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '@core/events';
import type { RemoteSession } from '@core/remote';
import { createTaskManager, type TaskSummaryMeta } from '../src/main/task-manager.js';
import type { ConnectFn, SpawnFn } from '../src/main/session-service.js';
import type { ServerRuntime } from '../src/main/resolve-runtime.js';
import { IPC_CHANNELS } from '../src/shared/ipc.js';
import type { TaskSummary } from '../src/shared/ipc.js';

const runtime: ServerRuntime = { nodeBin: 'node', cliJs: '/fake/cli.js', runAsNode: false };

interface FakeWorld {
  /** 每次 spawn 依序取的 storeId(模拟 serve 起来后 bootstrap 出的会话)。 */
  nextIds: string[];
  spawnedArgs: string[][];
  running: Set<string>;
  disposed: string[];
  metas: TaskSummaryMeta[];
  /** 每个假会话的事件总线(测试据此模拟 sidecar 侧的事件/崩溃)。 */
  buses: Map<string, EventBus>;
  /** 每个假会话镜像的 historyLength(模拟首条消息落地)。 */
  historyLengths: Map<string, number>;
  /** stateChanged 订阅者(测试据此触发镜像状态变化)。 */
  stateListeners: Map<string, Set<() => void>>;
}

function makeWorld(): FakeWorld {
  return {
    nextIds: [],
    spawnedArgs: [],
    running: new Set(),
    disposed: [],
    metas: [],
    buses: new Map(),
    historyLengths: new Map(),
    stateListeners: new Map(),
  };
}

/** 模拟一帧 state 到达镜像(applyState 尾部的通知)。 */
function fireStateChanged(world: FakeWorld, id: string): void {
  for (const listener of world.stateListeners.get(id) ?? []) listener();
}

function fakeSession(world: FakeWorld, id: string): RemoteSession {
  const bus = new EventBus();
  world.buses.set(id, bus);
  const stateListeners = new Set<() => void>();
  world.stateListeners.set(id, stateListeners);
  return {
    bus,
    store: { id, messages: [], displayMessages: [] },
    get snapshot() {
      return {
        root: '/w',
        storeId: id,
        agent: {
          isRunning: world.running.has(id),
          isCompacting: false,
          historyLength: world.historyLengths.get(id) ?? 0,
        },
        goal: { active: false, busy: false },
        todos: [],
        skills: [],
        provider: {},
        config: {},
        mcpStatuses: [],
        sentAt: 0,
      };
    },
    todos: { get: () => [], subscribe: () => () => {} },
    skillsChanged: () => () => {},
    stateChanged: (listener: () => void) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    gate: { setAsker: () => {} },
    // 回放读 displayMessages(buildReplayItems);isRunning 是含乐观标志的
    // getter(taskSummaries/容量淘汰读它),假对象同样从 world 取。
    agent: {
      get isRunning() {
        return world.running.has(id);
      },
      run: vi.fn(async () => {}),
    },
    dispose: vi.fn(async () => {
      world.disposed.push(id);
    }),
    notifyServerExit: vi.fn(),
  } as unknown as RemoteSession;
}

function makeManager(world: FakeWorld, opts?: { maxActive?: number }) {
  const sends: Array<{ channel: string; args: unknown[] }> = [];
  const spawnServer: SpawnFn = async (_runtime, serveArgs) => {
    world.spawnedArgs.push(serveArgs);
    return { url: 'http://127.0.0.1:1', token: 't', waitExit: async () => {} };
  };
  const connect: ConnectFn = async () => {
    const id = world.nextIds.shift();
    if (!id) throw new Error('fake nextIds 用尽');
    return fakeSession(world, id);
  };
  const manager = createTaskManager({
    runtime,
    target: { send: (channel, ...args) => sends.push({ channel, args }) },
    maxActive: opts?.maxActive,
    spawnServer,
    connect,
    listSessions: async () => world.metas,
  });
  return { manager, sends };
}

const meta = (id: string, root = '/w'): TaskSummaryMeta => ({
  id,
  root,
  provider: 'kimi',
  model: 'm',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  title: `任务 ${id}`,
  messageCount: 1,
});

describe('createTaskManager', () => {
  it('createTask:taskId = storeId,聚焦落在新任务,tasks 通道带运行时状态', async () => {
    const world = makeWorld();
    world.nextIds = ['s-1'];
    world.metas = [meta('s-1')];
    const { manager, sends } = makeManager(world);

    const taskId = await manager.createTask({ root: '/w' });
    expect(taskId).toBe('s-1');
    expect(manager.focusedTaskId).toBe('s-1');
    expect(world.spawnedArgs[0]).toEqual(['--cwd', '/w']);

    const pushes = sends.filter((entry) => entry.channel === IPC_CHANNELS.tasks);
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    const rows = pushes.at(-1)!.args[0] as TaskSummary[];
    expect(rows[0]).toMatchObject({ id: 's-1', status: 'connected', isRunning: false });
  });

  it('首条消息落地:镜像 historyLength 兜底 messageCount,state 变化重推 tasks', async () => {
    const world = makeWorld();
    world.nextIds = ['s-1'];
    world.metas = [{ ...meta('s-1'), messageCount: 0 }];
    const { manager, sends } = makeManager(world);
    await manager.createTask({ root: '/w' });

    const taskPushes = () => sends.filter((e) => e.channel === IPC_CHANNELS.tasks);
    const lastRows = () => taskPushes().at(-1)!.args[0] as TaskSummary[];
    // 新建时是空会话:messageCount 0(侧栏据此不显示行)。
    expect(lastRows()[0]).toMatchObject({ id: 's-1', messageCount: 0 });

    // 第一轮开始:isRunning 翻转 + 首条消息进镜像 → 重推,行即时「有内容」
    // (磁盘 meta 还是 0,persist 有滞后)。
    world.running.add('s-1');
    world.historyLengths.set('s-1', 1);
    const before = taskPushes().length;
    fireStateChanged(world, 's-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(taskPushes().length).toBe(before + 1);
    expect(lastRows()[0]).toMatchObject({ id: 's-1', messageCount: 1, isRunning: true });

    // 行不关心的 state 帧(config/todos 等)不触发磁盘 list() 重推。
    fireStateChanged(world, 's-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(taskPushes().length).toBe(before + 1);
  });

  it('首问乐观出现:run RPC 一经分发即重推,行带内容与乐观标题', async () => {
    const world = makeWorld();
    world.nextIds = ['s-1'];
    world.metas = [{ ...meta('s-1'), messageCount: 0, title: '' }];
    const { manager, sends } = makeManager(world);
    await manager.createTask({ root: '/w' });
    const taskPushes = () => sends.filter((e) => e.channel === IPC_CHANNELS.tasks);
    const before = taskPushes().length;

    // 不等镜像 state 帧(真实一轮里它最早在 step-end 才带出 historyLength)。
    await manager.dispatchRpc({ kind: 'run', text: '帮我修个 bug' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(taskPushes().length).toBeGreaterThan(before);
    const row = (taskPushes().at(-1)!.args[0] as TaskSummary[])[0]!;
    expect(row).toMatchObject({ id: 's-1', messageCount: 1, title: '帮我修个 bug' });

    // 磁盘 meta 生成标题后乐观标题让位。
    world.metas = [{ ...meta('s-1'), messageCount: 2, title: '正式标题' }];
    world.running.add('s-1');
    fireStateChanged(world, 's-1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const later = (taskPushes().at(-1)!.args[0] as TaskSummary[])[0]!;
    expect(later).toMatchObject({ messageCount: 2, title: '正式标题', isRunning: true });
  });

  it('openTask:休眠会话以 --resume 复活(root 取自 meta);活跃的直接聚焦', async () => {
    const world = makeWorld();
    world.nextIds = ['s-1', 's-2'];
    world.metas = [meta('s-1'), meta('s-2', '/other')];
    const { manager } = makeManager(world);

    await manager.createTask({ root: '/w' });
    const opened = await manager.openTask('s-2');
    expect(opened).toBe('s-2');
    expect(world.spawnedArgs[1]).toEqual(['--cwd', '/other', '--resume', 's-2']);
    expect(manager.focusedTaskId).toBe('s-2');

    // 已活跃:不再 spawn,直接聚焦。
    await manager.openTask('s-1');
    expect(manager.focusedTaskId).toBe('s-1');
    expect(world.spawnedArgs).toHaveLength(2);
  });

  it('dispatchRpc:缺省路由聚焦任务;没有活跃任务时拒绝', async () => {
    const world = makeWorld();
    world.nextIds = ['s-1'];
    world.metas = [meta('s-1')];
    const { manager } = makeManager(world);
    await expect(manager.dispatchRpc({ kind: 'abort' })).rejects.toThrow('没有可用的活跃任务');
    await manager.createTask({ root: '/w' });
    // fake session 的 agent 没有 abort,走到 bridge 内部会抛——只验证路由不再拒绝。
    await expect(manager.dispatchRpc({ kind: 'abort' })).rejects.not.toThrow('没有可用的活跃任务');
  });

  it('容量淘汰:满员时淘汰非聚焦且非运行的最旧任务;全在忙则拒绝', async () => {
    const world = makeWorld();
    world.nextIds = ['s-1', 's-2', 's-3'];
    world.metas = [meta('s-1'), meta('s-2'), meta('s-3')];
    const { manager } = makeManager(world, { maxActive: 2 });

    await manager.createTask({ root: '/w' });
    await manager.createTask({ root: '/w' });
    // 满员:s-1(非聚焦、未运行)被淘汰,s-3 进来。
    await manager.createTask({ root: '/w' });
    expect(world.disposed).toEqual(['s-1']);
    expect(manager.focusedTaskId).toBe('s-3');

    // s-2 在跑、s-3 聚焦:无可淘汰 → 拒绝。
    world.running.add('s-2');
    world.nextIds = ['s-4'];
    await expect(manager.createTask({ root: '/w' })).rejects.toThrow('活跃任务已满');
  });

  it('closeTask:任务 dispose、聚焦清空、行在 tasks 里回落 dormant', async () => {
    const world = makeWorld();
    world.nextIds = ['s-1'];
    world.metas = [meta('s-1')];
    const { manager, sends } = makeManager(world);
    await manager.createTask({ root: '/w' });
    await manager.closeTask('s-1');
    expect(world.disposed).toEqual(['s-1']);
    expect(manager.focusedTaskId).toBeUndefined();
    const rows = sends.filter((e) => e.channel === IPC_CHANNELS.tasks).at(-1)!
      .args[0] as TaskSummary[];
    expect(rows[0]).toMatchObject({ id: 's-1', status: 'dormant', isRunning: false });
  });

  it('subscribe:聚焦任务带回放,live 覆盖全部活跃任务', async () => {
    const world = makeWorld();
    world.nextIds = ['s-1'];
    world.metas = [meta('s-1')];
    const { manager } = makeManager(world);
    await manager.createTask({ root: '/w' });
    const result = await manager.subscribe();
    expect(result.focusedTaskId).toBe('s-1');
    expect(result.live).toHaveLength(1);
    expect(result.live[0]).toMatchObject({ taskId: 's-1', connection: 'connected' });
    expect(Array.isArray(result.live[0]!.replayItems)).toBe(true);
    expect(result.tasks?.[0]?.id).toBe('s-1');
  });

  it('disposeAll:全部任务收尾,之后 createTask 拒绝', async () => {
    const world = makeWorld();
    world.nextIds = ['s-1', 's-2'];
    world.metas = [meta('s-1'), meta('s-2')];
    const { manager } = makeManager(world);
    await manager.createTask({ root: '/w' });
    await manager.createTask({ root: '/w' });
    await manager.disposeAll();
    expect(new Set(world.disposed)).toEqual(new Set(['s-1', 's-2']));
    world.nextIds = ['s-3'];
    await expect(manager.createTask({ root: '/w' })).rejects.toThrow('已关闭');
  });
});
