/**
 * IPC 桥单测:createBridge 的依赖以最小形状注入,无需 mock electron。
 * 覆盖:事件批量合并、状态去重推送、权限 asker 往返、订阅幂等(含挂起审批
 * 重发)、dispose 收尾挂起审批、不可恢复错误 → lost、RPC 白名单透传。
 */

import { describe, expect, it, vi } from 'vitest';
import { EventBus, type PermissionAsker } from '@core/events';
import type { StateSnapshot } from '@core/protocol';
import type { RemoteSession } from '@core/remote';
import { createBridge, type Bridge, type BridgeTarget } from '../src/main/bridge.js';
import { IPC_CHANNELS, type RpcRequest } from '../src/shared/ipc.js';

/** 等到所有已排队的微任务(含桥的合并 flush)跑完。 */
const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const makeSnapshot = (seed: number): StateSnapshot =>
  ({
    root: '/tmp/demo',
    provider: { provider: 'glm', model: `glm-${seed}`, apiKey: '', headers: {} },
    config: {},
    mcpStatuses: [],
    storeId: 's1',
    agent: { isRunning: false, isCompacting: false, historyLength: 0 },
    goal: { active: false, busy: false },
    todos: [],
    skills: [],
    sentAt: seed,
  }) as unknown as StateSnapshot;

interface AgentSpies {
  run: ReturnType<typeof vi.fn>;
  inject: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

interface Harness {
  bridge: Bridge;
  bus: EventBus;
  /** (channel, args) 的发送记录。 */
  sends: Array<{ channel: string; args: unknown[] }>;
  asker: () => PermissionAsker;
  agents: AgentSpies;
  /** 命令类 RPC 的 spy(runSkill/startReview/startSimplify/listProviderModels)。 */
  commands: {
    runSkill: ReturnType<typeof vi.fn>;
    startReview: ReturnType<typeof vi.fn>;
    startSimplify: ReturnType<typeof vi.fn>;
    listProviderModels: ReturnType<typeof vi.fn>;
  };
  setSnapshot(seed: number): void;
}

function makeHarness(snapshotSeed = 1): Harness {
  const bus = new EventBus();
  let snapshot = makeSnapshot(snapshotSeed);
  const sends: Harness['sends'] = [];
  let asker: PermissionAsker | undefined;

  const agents: AgentSpies = {
    run: vi.fn().mockResolvedValue(undefined),
    inject: vi.fn().mockResolvedValue(true),
    abort: vi.fn(),
  };
  const commands = {
    runSkill: vi.fn().mockResolvedValue(undefined),
    startReview: vi.fn().mockResolvedValue({ ok: true }),
    startSimplify: vi.fn().mockResolvedValue({ ok: true }),
    listProviderModels: vi.fn().mockResolvedValue([]),
  };
  const session = {
    get snapshot() {
      return snapshot;
    },
    bus,
    todos: { get: () => [], subscribe: () => () => {} },
    skillsChanged: () => () => {},
    gate: {
      setAsker: (ask: PermissionAsker) => {
        asker = ask;
      },
    },
    agent: { ...agents, compact: vi.fn().mockResolvedValue(undefined) },
    newSession: vi.fn().mockResolvedValue({ id: 's2' }),
    resumeSession: vi.fn().mockResolvedValue({ id: 's2' }),
    forkSession: vi.fn().mockResolvedValue({ id: 's3' }),
    // 模拟旧 server:listSessions 尚不存在,pushSessions 捕获后以 undefined
    // 下发(侧栏降级)。
    listSessions: vi.fn().mockRejectedValue(new Error('unknown method: listSessions')),
    ...commands,
    switch: vi.fn().mockResolvedValue(undefined),
    setPermissions: vi.fn(),
    setPlan: vi.fn(),
  } as unknown as RemoteSession;

  const bridge = createBridge({
    target: {
      send: (channel, ...args) => {
        sends.push({ channel, args });
      },
    },
    session,
    replay: async () => [],
  });

  return {
    bridge,
    bus,
    sends,
    asker: () => {
      if (!asker) throw new Error('asker 未注册');
      return asker;
    },
    agents,
    commands,
    setSnapshot: (seed: number) => {
      snapshot = makeSnapshot(seed);
    },
  };
}

const sendsOf = (h: Harness, channel: string) => h.sends.filter((entry) => entry.channel === channel);

const invokeRpc = async <T>(h: Harness, request: RpcRequest): Promise<T> =>
  (await h.bridge.dispatchRpc(request)) as T;

const invokeSubscribe = async (h: Harness): Promise<{ state: StateSnapshot; connection: string }> =>
  await h.bridge.subscribe();

describe('createBridge', () => {
  it('事件批量合并:同一微任务内的多条事件一次 send', async () => {
    const h = makeHarness();
    h.bus.emit({ type: 'text-start', id: 't1' });
    h.bus.emit({ type: 'text-delta', id: 't1', text: '你好' });
    h.bus.emit({ type: 'text-delta', id: 't1', text: '世界' });
    expect(h.sends).toHaveLength(0); // 微任务前不 flush
    await flushMicrotasks();
    const frames = sendsOf(h, IPC_CHANNELS.event);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.args[0]).toHaveLength(3);
  });

  it('error 事件拆成 WireError 形态(可过 structured clone)', async () => {
    const h = makeHarness();
    h.bus.emit({ type: 'error', error: new Error('boom'), recoverable: true });
    await flushMicrotasks();
    const events = sendsOf(h, IPC_CHANNELS.event)[0]!.args[0] as unknown[];
    expect(events[0]).toEqual({
      type: 'error',
      error: { name: 'Error', message: 'boom' },
      recoverable: true,
    });
  });

  it('状态推送:事件后合并推送,snapshotKey 未变则去重', async () => {
    const h = makeHarness();
    h.bus.emit({ type: 'text-start', id: 't1' });
    await flushMicrotasks();
    expect(sendsOf(h, IPC_CHANNELS.state)).toHaveLength(1);

    // 快照内容未变:后续事件不再推状态。
    h.bus.emit({ type: 'text-delta', id: 't1', text: 'x' });
    await flushMicrotasks();
    expect(sendsOf(h, IPC_CHANNELS.state)).toHaveLength(1);

    // 快照变了(model 不同 → key 不同):再推。
    h.setSnapshot(99);
    h.bus.emit({ type: 'text-delta', id: 't1', text: 'y' });
    await flushMicrotasks();
    expect(sendsOf(h, IPC_CHANNELS.state)).toHaveLength(2);
  });

  it('权限往返:asker 下发,rpc permission 兑现决定', async () => {
    const h = makeHarness();
    const pending = h.asker()({ id: 'p1', toolName: 'bash', title: 'bash: ls', risk: 'execute' });
    await flushMicrotasks();
    const pushes = sendsOf(h, IPC_CHANNELS.permission);
    expect(pushes).toHaveLength(1);
    expect((pushes[0]!.args[0] as { id: string }).id).toBe('p1');

    const ok = await invokeRpc<boolean>(h, {
      kind: 'permission',
      id: 'p1',
      decision: { type: 'allow-always', rule: 'Bash(ls)' },
    });
    expect(ok).toBe(true);
    await expect(pending).resolves.toEqual({ type: 'allow-always', rule: 'Bash(ls)' });
  });

  it('rpc permission 对未知 id 幂等返回 false', async () => {
    const h = makeHarness();
    expect(
      await invokeRpc<boolean>(h, { kind: 'permission', id: '不存在', decision: { type: 'allow' } }),
    ).toBe(false);
  });

  it('订阅幂等:重复 subscribe 返回快照并重推回放', async () => {
    const h = makeHarness();
    const first = await invokeSubscribe(h);
    const second = await invokeSubscribe(h);
    expect(first.state.root).toBe('/tmp/demo');
    expect(second.state.root).toBe('/tmp/demo');
    expect(sendsOf(h, IPC_CHANNELS.replay)).toHaveLength(2);
  });

  it('订阅时重发挂起的审批(renderer 重载恢复路径)', async () => {
    const h = makeHarness();
    const pending = h.asker()({ id: 'p9', toolName: 'write', title: 'write: a.ts', risk: 'write' });
    await flushMicrotasks();
    await invokeSubscribe(h);
    const pushes = sendsOf(h, IPC_CHANNELS.permission);
    expect(pushes).toHaveLength(2); // asker 首发 + 订阅重发
    await invokeRpc(h, { kind: 'permission', id: 'p9', decision: { type: 'deny' } });
    await expect(pending).resolves.toEqual({ type: 'deny' });
  });

  it('dispose 把挂起的审批收尾为 deny(attach 模式 server 不随 GUI 退出)', async () => {
    const h = makeHarness();
    const pending = h.asker()({ id: 'p2', toolName: 'bash', title: 'bash: rm', risk: 'execute' });
    await flushMicrotasks();
    h.bridge.dispose();
    await expect(pending).resolves.toEqual({ type: 'deny', reason: 'client closed' });
  });

  it('dispose 后不再推送(事件与状态)', async () => {
    const h = makeHarness();
    h.bridge.dispose();
    h.bus.emit({ type: 'text-start', id: 't1' });
    await flushMicrotasks();
    expect(sendsOf(h, IPC_CHANNELS.event)).toHaveLength(0);
    expect(sendsOf(h, IPC_CHANNELS.state)).toHaveLength(0);
  });

  it('不可恢复错误事件 → connection lost', async () => {
    const h = makeHarness();
    h.bus.emit({ type: 'error', error: new Error('server died'), recoverable: false });
    await flushMicrotasks();
    const connections = sendsOf(h, IPC_CHANNELS.connection).map((e) => e.args[0]);
    expect(connections).toContain('lost');
  });

  it('rpc 白名单:run/inject/abort 透传到 session.agent', async () => {
    const h = makeHarness();
    await invokeRpc(h, { kind: 'run', text: 'hi', options: { display: 'hi' } });
    await invokeRpc(h, { kind: 'inject', text: 'mid' });
    await invokeRpc(h, { kind: 'abort' });
    expect(h.agents.run).toHaveBeenCalledWith('hi', { display: 'hi' });
    expect(h.agents.inject).toHaveBeenCalledWith('mid', undefined);
    expect(h.agents.abort).toHaveBeenCalled();
  });

  it('rpc 白名单:命令类方法透传到 session 成员', async () => {
    const h = makeHarness();
    await invokeRpc(h, { kind: 'runSkill', name: 'release', args: 'v1', display: '/release v1' });
    await invokeRpc(h, { kind: 'startReview', scope: 'uncommitted' });
    await invokeRpc(h, { kind: 'startSimplify', target: '' });
    await invokeRpc(h, { kind: 'listProviderModels' });
    expect(h.commands.runSkill).toHaveBeenCalledWith('release', 'v1', { display: '/release v1' });
    expect(h.commands.startReview).toHaveBeenCalledWith('uncommitted');
    expect(h.commands.startSimplify).toHaveBeenCalledWith('');
    expect(h.commands.listProviderModels).toHaveBeenCalled();
  });

  it('runSkill 不带 display 时不传 options(与 TUI 的调用形态一致)', async () => {
    const h = makeHarness();
    await invokeRpc(h, { kind: 'runSkill', name: 'lint', args: '' });
    expect(h.commands.runSkill).toHaveBeenCalledWith('lint', '', undefined);
  });

  it('listSessions 透传;旧 server 的报错原样拒绝(RPC 层不吞)', async () => {
    const h = makeHarness();
    await expect(invokeRpc(h, { kind: 'listSessions' })).rejects.toThrow('unknown method');
  });

  it('newSession 后重推会话列表与回放(afterSessionSwitch);旧 server 降级为 undefined', async () => {
    const h = makeHarness();
    await invokeRpc(h, { kind: 'newSession' });
    const replays = sendsOf(h, IPC_CHANNELS.replay);
    expect(replays.length).toBeGreaterThanOrEqual(1);
    const sessions = sendsOf(h, IPC_CHANNELS.sessions);
    expect(sessions.length).toBeGreaterThanOrEqual(1); // 降级也是一次显式下发
    expect(sessions.every((entry) => entry.args[0] === undefined)).toBe(true);
  });
});
