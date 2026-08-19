/**
 * IPC 桥单测:createBridge 的依赖以最小形状注入,无需 mock electron。
 * 覆盖:TaskScoped 信封、事件批量合并、状态去重推送、权限 asker 往返、
 * 订阅幂等(含挂起审批重发)、dispose 收尾挂起审批、不可恢复错误 → lost、
 * RPC 白名单透传、onSessionsMutated 通知。换会话三连已退役,不再有对应用例。
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
  abort: ReturnType<typeof vi.fn>;
}

interface Harness {
  bridge: Bridge;
  bus: EventBus;
  onSessionsMutated: ReturnType<typeof vi.fn>;
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
  /** 设置页·模型设置的 RPC spy。 */
  providerOps: {
    saveProvider: ReturnType<typeof vi.fn>;
    deleteProvider: ReturnType<typeof vi.fn>;
    testModel: ReturnType<typeof vi.fn>;
    modelCapabilities: ReturnType<typeof vi.fn>;
  };
  /** 模拟远端镜像的 state 帧更新(remote.applyState → stateChanged 通知)。 */
  fireStateChanged: () => void;
  setSnapshot(seed: number): void;
}

function makeHarness(snapshotSeed = 1): Harness {
  const bus = new EventBus();
  let snapshot = makeSnapshot(snapshotSeed);
  const sends: Harness['sends'] = [];
  let asker: PermissionAsker | undefined;

  const agents: AgentSpies = {
    run: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
  };
  const commands = {
    runSkill: vi.fn().mockResolvedValue(undefined),
    startReview: vi.fn().mockResolvedValue({ ok: true }),
    startSimplify: vi.fn().mockResolvedValue({ ok: true }),
    listProviderModels: vi.fn().mockResolvedValue([]),
  };
  const providerOps = {
    saveProvider: vi.fn().mockResolvedValue(undefined),
    deleteProvider: vi.fn().mockResolvedValue(undefined),
    testModel: vi.fn().mockResolvedValue({ ok: true, status: 200, durationMs: 12 }),
    modelCapabilities: vi
      .fn()
      .mockResolvedValue({ contextWindow: 1_000_000, efforts: ['auto', 'off', 'high'] }),
  };
  let stateListener: (() => void) | undefined;
  const session = {
    get snapshot() {
      return snapshot;
    },
    bus,
    todos: { get: () => [], subscribe: () => () => {} },
    skillsChanged: () => () => {},
    stateChanged: (listener: () => void) => {
      stateListener = listener;
      return () => {
        stateListener = undefined;
      };
    },
    gate: {
      setAsker: (ask: PermissionAsker) => {
        asker = ask;
      },
    },
    agent: { ...agents, compact: vi.fn().mockResolvedValue(undefined) },
    archiveSession: vi.fn().mockResolvedValue({ id: 's1', archivedAt: '2026-01-01T00:00:00Z' }),
    ...commands,
    switch: vi.fn().mockResolvedValue(undefined),
    ...providerOps,
    setPermissions: vi.fn(),
    setPlan: vi.fn(),
  } as unknown as RemoteSession;

  const onSessionsMutated = vi.fn();
  const bridge = createBridge({
    taskId: 'task-1',
    target: {
      send: (channel, ...args) => {
        sends.push({ channel, args });
      },
    },
    session,
    replay: async () => [],
    onSessionsMutated,
  });

  return {
    bridge,
    bus,
    onSessionsMutated,
    sends,
    asker: () => {
      if (!asker) throw new Error('asker 未注册');
      return asker;
    },
    agents,
    commands,
    providerOps,
    setSnapshot: (seed: number) => {
      snapshot = makeSnapshot(seed);
    },
    fireStateChanged: () => stateListener?.(),
  };
}

const sendsOf = (h: Harness, channel: string) => h.sends.filter((entry) => entry.channel === channel);

/** 下行推送都包 TaskScoped 信封:{ taskId, data }。 */
const payloadOf = (entry: { args: unknown[] }): unknown =>
  (entry.args[0] as { taskId: string; data: unknown }).data;

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
    expect((frames[0]!.args[0] as { taskId: string }).taskId).toBe('task-1');
    expect(payloadOf(frames[0]!)).toHaveLength(3);
  });

  it('error 事件拆成 WireError 形态(可过 structured clone)', async () => {
    const h = makeHarness();
    h.bus.emit({ type: 'error', error: new Error('boom'), recoverable: true });
    await flushMicrotasks();
    const events = payloadOf(sendsOf(h, IPC_CHANNELS.event)[0]!) as unknown[];
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
    expect((payloadOf(pushes[0]!) as { id: string }).id).toBe('p1');

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
    const connections = sendsOf(h, IPC_CHANNELS.connection).map((e) => payloadOf(e));
    expect(connections).toContain('lost');
  });

  it('rpc 白名单:run/abort 透传到 session.agent', async () => {
    const h = makeHarness();
    await invokeRpc(h, { kind: 'run', text: 'hi', options: { display: 'hi' } });
    await invokeRpc(h, { kind: 'abort' });
    expect(h.agents.run).toHaveBeenCalledWith('hi', { display: 'hi' });
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

  it('镜像 state 帧更新(stateChanged)触发快照重推——saveProvider/switch 这类纯状态变更没有 bus 事件', async () => {
    const h = makeHarness();
    await invokeSubscribe(h);
    await flushMicrotasks();
    const before = sendsOf(h, IPC_CHANNELS.state).length;
    h.setSnapshot(2); // 模拟 server 推来的新快照已写入镜像
    h.fireStateChanged();
    await flushMicrotasks();
    expect(sendsOf(h, IPC_CHANNELS.state).length).toBe(before + 1);
  });

  it('rpc 白名单:testModel 透传并带回连通结果', async () => {
    const h = makeHarness();
    const result = await invokeRpc(h, { kind: 'testModel', id: 'glm-coding', model: 'GLM-5.3' });
    expect(h.providerOps.testModel).toHaveBeenCalledWith('glm-coding', 'GLM-5.3');
    expect(result).toEqual({ ok: true, status: 200, durationMs: 12 });
  });

  it('rpc 白名单:modelCapabilities 透传(models.dev 能力目录)', async () => {
    const h = makeHarness();
    const result = await invokeRpc(h, { kind: 'modelCapabilities', id: 'kimi', model: 'kimi-k3' });
    expect(h.providerOps.modelCapabilities).toHaveBeenCalledWith('kimi', 'kimi-k3');
    expect(result).toEqual({ contextWindow: 1_000_000, efforts: ['auto', 'off', 'high'] });
  });

  it('rpc 白名单:saveProvider/deleteProvider 透传(设置页·模型设置)', async () => {
    const h = makeHarness();
    await invokeRpc(h, {
      kind: 'saveProvider',
      id: 'glm',
      config: { models: [{ id: 'GLM-5.3', contextWindow: 1_000_000 }] },
    });
    await invokeRpc(h, { kind: 'deleteProvider', id: 'custom-x' });
    expect(h.providerOps.saveProvider).toHaveBeenCalledWith('glm', {
      models: [{ id: 'GLM-5.3', contextWindow: 1_000_000 }],
    });
    expect(h.providerOps.deleteProvider).toHaveBeenCalledWith('custom-x');
  });

  it('runSkill 不带 display 时不传 options(与 TUI 的调用形态一致)', async () => {
    const h = makeHarness();
    await invokeRpc(h, { kind: 'runSkill', name: 'lint', args: '' });
    expect(h.commands.runSkill).toHaveBeenCalledWith('lint', '', undefined);
  });

  it('后台抑制:setForwarding(false) 后事件不过 IPC,但 state 照推', async () => {
    const h = makeHarness();
    h.bridge.setForwarding(false);
    h.bus.emit({ type: 'text-start', id: 't1' });
    h.bus.emit({ type: 'text-delta', id: 't1', text: 'x' });
    await flushMicrotasks();
    expect(sendsOf(h, IPC_CHANNELS.event)).toHaveLength(0);
    expect(sendsOf(h, IPC_CHANNELS.state).length).toBeGreaterThanOrEqual(1);
  });

  it('当前轮缓冲:聚焦回来时按序补齐;turn-start 清空、turn-end 收尾', async () => {
    const h = makeHarness();
    h.bridge.setForwarding(false);
    h.bus.emit({ type: 'turn-start', userText: 'hi' });
    h.bus.emit({ type: 'text-delta', id: 't1', text: '进行中' });
    await flushMicrotasks();

    h.bridge.replayBuffered();
    const frames = sendsOf(h, IPC_CHANNELS.event);
    expect(frames).toHaveLength(1);
    const events = payloadOf(frames[0]!) as Array<{ type: string }>;
    expect(events.map((event) => event.type)).toEqual(['turn-start', 'text-delta']);

    // 轮结束后缓冲清空:再补齐没有内容可发。
    h.bus.emit({
      type: 'turn-end',
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 1,
    } as never);
    await flushMicrotasks();
    const before = sendsOf(h, IPC_CHANNELS.event).length;
    h.bridge.replayBuffered();
    expect(sendsOf(h, IPC_CHANNELS.event)).toHaveLength(before);
  });

  it('archiveSession 成功后通知 onSessionsMutated(TaskManager 重推 tasks)', async () => {
    const h = makeHarness();
    await invokeRpc(h, { kind: 'archiveSession', id: 's1', archived: true });
    expect(h.onSessionsMutated).toHaveBeenCalledTimes(1);
  });

  it('pendingPermissionRequest 反映挂起审批(TaskSummary 角标数据源)', async () => {
    const h = makeHarness();
    expect(h.bridge.pendingPermissionRequest()).toBeUndefined();
    const pending = h.asker()({ id: 'p3', toolName: 'bash', title: 'bash: ls', risk: 'execute' });
    expect(h.bridge.pendingPermissionRequest()?.id).toBe('p3');
    await invokeRpc(h, { kind: 'permission', id: 'p3', decision: { type: 'deny' } });
    expect(h.bridge.pendingPermissionRequest()).toBeUndefined();
    await expect(pending).resolves.toEqual({ type: 'deny' });
  });
});
