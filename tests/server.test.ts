import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus, type PermissionRequest } from '../src/core/events.js';
import type { StateSnapshot } from '../src/server/protocol.js';
import { t } from '../src/i18n/index.js';
import { TodoStore } from '../src/tools/index.js';
import { createPermissionBroker, startServer, type RunningServer } from '../src/server/serve.js';
import { connectRemote, type RemoteSession } from '../src/client/remote.js';
import { ProviderSwitchError, type Session } from '../src/app/bootstrap.js';
import type { ResolvedProvider } from '../src/config/load.js';
import type { Config } from '../src/config/schema.js';
import type { ModelMessage } from 'ai';

/**
 * client-server 进程模型(对齐 opencode)的协议级测试:真 HTTP + 真 SSE,
 * 但会话是手工假对象——server 只依赖 Session 的公开面,这里把依赖面钉死。
 */

const provider: ResolvedProvider = {
  id: 'kimi',
  label: 'Kimi',
  baseURL: 'https://example.invalid/v1',
  apiKey: 'super-secret',
  model: 'kimi-k2',
  headers: { 'x-secret': 'yes' },
  contextWindow: 128_000,
  parallelToolCalls: true,
  reasoningEffort: 'auto',
  sdk: 'openai-compatible',
};

const config = {
  provider: 'kimi',
  model: 'kimi-k2',
  sandbox: 'workspace-write',
  approval: 'on-request',
  plan: false,
  statusBar: [],
  timeline: 'full',
  goalMaxTurns: 10,
  providers: { kimi: { apiKey: 'super-secret' } },
  search: { backend: 'off', apiKey: 'search-secret' },
  permissions: { allowBash: [], denyBash: [], allowWrite: [], denyPath: [], allowNet: [] },
  mcpServers: {
    local: { type: 'stdio', command: 'gh-mcp', args: [], env: { GITHUB_TOKEN: 'ghp_secret' }, enabled: true },
    remote: { type: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer secret' }, enabled: true },
  },
} as unknown as Config;

type FakeParts = ReturnType<typeof fakeSession>;

function fakeSession() {
  const bus = new EventBus();
  const todos = new TodoStore();
  let history: ModelMessage[] = [{ role: 'user', content: 'hello' }];
  let displayPrefix: ModelMessage[] = [{ role: 'user', content: 'compacted-away' }];
  const runGate: { resolve?: () => void } = {};
  let running = false;

  const spies = {
    run: vi.fn(async () => {
      running = true;
      bus.emit({ type: 'turn-start', userText: 'hi' });
      await new Promise<void>((resolve) => {
        runGate.resolve = () => {
          running = false;
          resolve();
        };
      });
    }),
    inject: vi.fn(() => true),
    abort: vi.fn(),
    setHistory: vi.fn((messages: ModelMessage[]) => {
      history = messages;
    }),
    save: vi.fn(async () => {}),
    switch: vi.fn(() => ({ ...provider, model: 'kimi-next' })),
    setPermissions: vi.fn(),
    setPlan: vi.fn(),
    setReasoningEffort: vi.fn(),
    goalSet: vi.fn(),
    resumeSession: vi.fn(async () => {
      throw new ProviderSwitchError(new Error('missing key for glm'));
    }),
    runSkill: vi.fn(async () => {}),
    reviewTargets: vi.fn(async () => ({
      isRepo: true,
      detached: false,
      currentBranch: 'main',
      branches: [{ name: 'feature', subject: 'first' }],
    })),
    reviewCommits: vi.fn(async () => [
      { sha: 'abc1234', subject: 'second: add b', date: '2 hours ago' },
      { sha: 'def5678', subject: 'first', date: '3 hours ago' },
    ]),
    startReview: vi.fn(async () => ({ ok: true })),
    startSimplify: vi.fn(async () => ({ ok: true })),
    refreshSkills: vi.fn(async () => [{ name: 'demo', description: 'demo skill' }]),
  };

  const session = {
    root: '/tmp/fake-root',
    config,
    provider,
    bus,
    agent: {
      get isRunning() {
        return running;
      },
      isCompacting: false,
      get history() {
        return history;
      },
      run: spies.run,
      inject: spies.inject,
      abort: spies.abort,
      compact: vi.fn(async () => {}),
      setHistory: spies.setHistory,
    },
    gate: { setAsker: vi.fn() },
    todos,
    goal: {
      active: false,
      busy: false,
      state: undefined,
      set: spies.goalSet,
      clear: vi.fn(),
      snapshot: () => undefined,
      steer: vi.fn(() => false),
      run: vi.fn(async () => {}),
    },
    mcpStatuses: [{ name: 'srv', connected: true, toolCount: 2 }],
    store: {
      id: 'session-0001',
      get messages() {
        return history;
      },
      // 展示历史比模型历史多一条被压缩掉的早期消息,镜像测试据此区分两者;
      // 置空前缀即"从未压缩过的会话",两份历史逐条相同。
      get displayMessages() {
        return [...displayPrefix, ...history];
      },
      save: spies.save,
    },
    newSession: vi.fn(async () => {
      history = [];
      return { id: 'session-0002' };
    }),
    resumeSession: spies.resumeSession,
    forkSession: vi.fn(async () => ({ id: 'session-0003' })),
    switch: spies.switch,
    setPermissions: spies.setPermissions,
    setPlan: spies.setPlan,
    setReasoningEffort: spies.setReasoningEffort,
    listProviderModels: vi.fn(async () => [
      { providerId: 'kimi', label: 'Kimi', models: [{ id: 'kimi-k2' }, { id: 'kimi-next' }] },
    ]),
    listModels: vi.fn(async () => [{ id: 'kimi-k2' }, { id: 'kimi-next' }]),
    doctor: vi.fn(async () => ({ healthy: true, sections: [] })),
    refreshEnvironment: vi.fn(async () => {}),
    skills: [{ name: 'demo', description: 'demo skill' }],
    skillsChanged: vi.fn(() => () => {}),
    refreshSkills: spies.refreshSkills,
    runSkill: spies.runSkill,
    reviewTargets: spies.reviewTargets,
    reviewCommits: spies.reviewCommits,
    startReview: spies.startReview,
    startSimplify: spies.startSimplify,
    dispose: vi.fn(async () => {}),
  } as unknown as Session;

  return {
    session,
    bus,
    todos,
    setHistory: (m: ModelMessage[]) => (history = m),
    setDisplayPrefix: (m: ModelMessage[]) => (displayPrefix = m),
    runGate,
    spies,
  };
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

async function boot(parts = fakeSession()): Promise<{
  parts: FakeParts;
  server: RunningServer;
  remote: RemoteSession;
}> {
  const broker = createPermissionBroker();
  const server = await startServer({ session: parts.session, broker });
  cleanups.push(() => server.close());
  const remote = await connectRemote({ url: server.url, token: server.token, ownsServer: false });
  cleanups.push(() => remote.dispose());
  return { parts, server, remote, broker } as never;
}

describe('server ↔ remote client', () => {
  it('初始镜像:root/provider/config 就位,凭据被抹除', async () => {
    const { remote } = await boot();
    expect(remote.root).toBe('/tmp/fake-root');
    expect(remote.provider.model).toBe('kimi-k2');
    expect(remote.provider.apiKey).toBe('');
    expect(remote.provider.headers).toEqual({});
    expect((remote.config.providers as Record<string, { apiKey?: string }>)['kimi']?.apiKey).toBe('');
    expect(remote.config.search.apiKey).toBe('');
    // MCP 的 env / headers 是 GITHUB_TOKEN、Authorization 的常规落点,
    // 同样不得过线(`serve --host <非环回>` + `--attach` 是支持的用法)。
    const servers = remote.config.mcpServers as unknown as Record<
      string,
      { env?: Record<string, string>; headers?: Record<string, string> }
    >;
    expect(servers['local']!.env!['GITHUB_TOKEN']).toBe('');
    expect(servers['remote']!.headers!['Authorization']).toBe('');
    // 键名保留:client 侧 /doctor、/mcp 只看结构。
    expect(Object.keys(servers['local']!.env!)).toEqual(['GITHUB_TOKEN']);
    expect(remote.store.id).toBe('session-0001');
    expect(remote.agent.history).toEqual([{ role: 'user', content: 'hello' }]);
    // 展示历史(压缩不缩减)独立于模型历史过线,`/resume` 回放靠它。
    expect(remote.store.displayMessages).toEqual([
      { role: 'user', content: 'compacted-away' },
      { role: 'user', content: 'hello' },
    ]);
    expect(remote.mcpStatuses).toHaveLength(1);
  });

  // /history 挂在 turn-end / aborted / compaction 上,是热路径:没压缩过的
  // 会话两份历史逐条相同,带上等于把整份记录发两遍。省略靠 client 的
  // `?? messages` 回退接住(与旧 server 同款路径)。
  it('两份历史相同时 /history 不重复发一遍展示历史', async () => {
    const parts = fakeSession();
    parts.setDisplayPrefix([]);
    const { server, remote } = await boot(parts);

    const payload = (await (
      await fetch(`${server.url}/history`, { headers: { authorization: `Bearer ${server.token}` } })
    ).json()) as { messages: ModelMessage[]; displayMessages?: ModelMessage[] };
    expect(payload.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect('displayMessages' in payload).toBe(false);
    // client 侧照样拿到可用的展示历史。
    expect(remote.store.displayMessages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('AgentEvent 经 SSE 到达 client 总线;error 事件的 Error 被复原', async () => {
    const { parts, remote } = await boot();
    const seen: string[] = [];
    let revived: Error | undefined;
    remote.bus.on((event) => {
      seen.push(event.type);
      if (event.type === 'error') revived = event.error;
    });
    parts.bus.emit({ type: 'notice', level: 'info', message: 'hi' });
    parts.bus.emit({ type: 'error', error: new Error('boom'), recoverable: true });
    await waitFor(() => seen.includes('error'));
    expect(seen).toContain('notice');
    expect(revived).toBeInstanceOf(Error);
    expect(revived?.message).toBe('boom');
  });

  it('todos 变化经 state 推送驱动 client 订阅者', async () => {
    const { parts, remote } = await boot();
    const snapshots: number[] = [];
    remote.todos.subscribe((items) => snapshots.push(items.length));
    parts.todos.set([{ content: 'a', status: 'pending' }]);
    await waitFor(() => snapshots.length > 0);
    expect(remote.todos.get()).toEqual([{ content: 'a', status: 'pending' }]);
  });

  it('skills 进快照镜像;refreshSkills 即时调用;runSkill 走 deferred', async () => {
    const { parts, remote } = await boot();
    expect(remote.skills).toEqual([{ name: 'demo', description: 'demo skill' }]);

    const list = await remote.refreshSkills();
    expect(parts.spies.refreshSkills).toHaveBeenCalledOnce();
    expect(list).toEqual([{ name: 'demo', description: 'demo skill' }]);

    await remote.runSkill('demo', 'foo bar', { display: '/demo foo bar' });
    expect(parts.spies.runSkill).toHaveBeenCalledWith('demo', 'foo bar', {
      display: '/demo foo bar',
    });
  });

  it('reviewTargets/reviewCommits 即时返回;startReview 走 deferred,乐观 run 标志随完成清除', async () => {
    const { parts, remote } = await boot();

    const targets = await remote.reviewTargets();
    expect(parts.spies.reviewTargets).toHaveBeenCalledOnce();
    expect(targets.isRepo).toBe(true);
    expect(targets.branches).toEqual([{ name: 'feature', subject: 'first' }]);

    const commits = await remote.reviewCommits();
    expect(parts.spies.reviewCommits).toHaveBeenCalledOnce();
    expect(commits[0]?.subject).toBe('second: add b');

    const pending = remote.startReview('base main', { display: '/review base main' });
    // 乐观 run 标志在 ack 之前同步置位:ack 往返的窗口期内 isRunning 不为 false。
    expect(remote.agent.isRunning).toBe(true);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(parts.spies.startReview).toHaveBeenCalledWith('base main', {
      display: '/review base main',
    });
    await waitFor(() => !remote.agent.isRunning);

    // /simplify 走同一条 deferred 通道,乐观标志同样随完成清除。
    const pendingSimplify = remote.startSimplify('src/foo.ts', { display: '/simplify src/foo.ts' });
    expect(remote.agent.isRunning).toBe(true);
    await expect(pendingSimplify).resolves.toEqual({ ok: true });
    expect(parts.spies.startSimplify).toHaveBeenCalledWith('src/foo.ts', {
      display: '/simplify src/foo.ts',
    });
    await waitFor(() => !remote.agent.isRunning);
  });

  it('即时调用:switch 返回抹除凭据后的 provider,参数原样到达', async () => {
    const { parts, remote } = await boot();
    const next = await remote.switch({ model: 'kimi-next' });
    expect(parts.spies.switch).toHaveBeenCalledWith({ provider: undefined, model: 'kimi-next' });
    expect(next.model).toBe('kimi-next');
    expect(next.apiKey).toBe('');
  });

  it('即时调用:listProviderModels 在 server 侧取分组并原样返回', async () => {
    const { parts, remote } = await boot();
    const groups = await remote.listProviderModels();
    expect(parts.session.listProviderModels).toHaveBeenCalledOnce();
    expect(groups[0]?.providerId).toBe('kimi');
    expect(groups[0]?.models.map((m) => m.id)).toEqual(['kimi-k2', 'kimi-next']);
  });

  it('兼容垫片:旧客户端的 listModels 仍可用,返回首组(当前厂商)模型', async () => {
    const { parts, server } = await boot();
    const res = await fetch(`${server.url}/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'legacy-1', method: 'listModels' }),
    });
    const payload = (await res.json()) as { ok: boolean; value: Array<{ id: string }> };
    expect(parts.session.listModels).toHaveBeenCalledOnce();
    expect(parts.session.listProviderModels).not.toHaveBeenCalled();
    expect(payload.ok).toBe(true);
    expect(payload.value.map((m) => m.id)).toEqual(['kimi-k2', 'kimi-next']);
  });

  it('switch 携带的 apiKey(选择器就地输入的新 key)原样过线', async () => {
    const { parts, remote } = await boot();
    await remote.switch({ provider: 'glm', apiKey: 'fresh-key' });
    expect(parts.spies.switch).toHaveBeenCalledWith({
      provider: 'glm',
      model: undefined,
      apiKey: 'fresh-key',
    });
  });

  it('长任务:run 先 ack(乐观 isRunning),完成回执经 SSE 兑现 promise', async () => {
    const { parts, remote } = await boot();
    const done = vi.fn();
    const promise = remote.agent.run('do stuff').then(done);
    await waitFor(() => parts.spies.run.mock.calls.length === 1);
    // server 侧仍在跑:promise 未兑现,镜像(乐观或推送)已报忙。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(done).not.toHaveBeenCalled();
    expect(remote.agent.isRunning).toBe(true);
    parts.runGate.resolve!();
    await promise;
    expect(done).toHaveBeenCalled();
    await waitFor(() => remote.agent.isRunning === false);
  });

  it('授权往返:permission-request 事件 → client asker → broker 兑现决定', async () => {
    const parts = fakeSession();
    const broker = createPermissionBroker();
    const server = await startServer({ session: parts.session, broker });
    cleanups.push(() => server.close());
    const remote = await connectRemote({ url: server.url, token: server.token, ownsServer: false });
    cleanups.push(() => remote.dispose());

    remote.gate.setAsker(async (request) => {
      expect(request.title).toBe('bash: rm -rf /tmp/x');
      return { type: 'allow-always', rule: 'Bash(rm:*)' };
    });

    const request: PermissionRequest = {
      id: 'perm-1',
      toolName: 'bash',
      title: 'bash: rm -rf /tmp/x',
      risk: 'execute',
    };
    // 模拟 gate:先发事件,再等 broker(与 gate.askSerialized 的顺序一致)。
    const decisionPromise = broker.ask(request);
    parts.bus.emit({ type: 'permission-request', request });
    const decision = await decisionPromise;
    expect(decision).toEqual({ type: 'allow-always', rule: 'Bash(rm:*)' });
  });

  it('回退链路:setHistory 即时更新镜像并送达 server,save 随后', async () => {
    const { parts, remote } = await boot();
    const truncated: ModelMessage[] = [];
    remote.agent.setHistory(truncated);
    expect(remote.agent.history).toBe(truncated);
    await remote.store.save(truncated);
    await waitFor(() => parts.spies.setHistory.mock.calls.length === 1);
    expect(parts.spies.save).toHaveBeenCalled();
  });

  it('resumeSession 的 ProviderSwitchError 过线后类型复原', async () => {
    const { remote } = await boot();
    await expect(remote.resumeSession('deadbeef')).rejects.toBeInstanceOf(ProviderSwitchError);
  });

  it('鉴权:缺 token 一律 401', async () => {
    const { server } = await boot();
    const res = await fetch(`${server.url}/state`);
    expect(res.status).toBe(401);
    const bad = await fetch(`${server.url}/call`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
      body: JSON.stringify({ id: 'x', method: 'abort' }),
    });
    expect(bad.status).toBe(401);
  });

  // 回归:授权请求只广播一次。断线重连、或 `--attach` 连上一个正跑到一半的
  // server 时,没有重放就永远等不到确认框,server 侧 gate 一直 await = 整轮挂死。
  it('待决的授权请求会重放给后接入的客户端', async () => {
    const parts = fakeSession();
    const broker = createPermissionBroker();
    const server = await startServer({ session: parts.session, broker });
    cleanups.push(() => server.close());

    const request: PermissionRequest = {
      id: 'perm-late',
      toolName: 'bash',
      title: 'bash: rm -rf /tmp/x',
      risk: 'execute',
    };
    // 没有任何客户端在场时发起询问——这一条广播注定没人收到。
    const decisionPromise = broker.ask(request);
    parts.bus.emit({ type: 'permission-request', request });

    // 客户端此刻才接入,并且在 App 挂载之前(asker 尚未注册)。
    const remote = await connectRemote({ url: server.url, token: server.token, ownsServer: false });
    cleanups.push(() => remote.dispose());
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 注册 asker:重放 + 排队两条路径合起来,请求必须最终到达。
    remote.gate.setAsker(async () => ({ type: 'allow' }));

    expect(await decisionPromise).toEqual({ type: 'allow' });
  });

  // SSE 断点续传:断线期间广播的 event / call-result 经序号缓冲无缝重放。
  // call-result 是重点——丢了它,pendingCalls 里的 promise 永不 settle,
  // App 的 setRunning(false) 永远等不到,状态行常亮到天荒地老。
  it('断线重连:缺失的事件与 call-result 无缝重放,不告警', async () => {
    const { parts, server, remote } = await boot();
    const seen: string[] = [];
    const warns: string[] = [];
    remote.bus.on((event) => {
      if (event.type === 'notice') {
        seen.push(event.message);
        if (event.level === 'warn') warns.push(event.message);
      }
    });

    // 一个尚未完成的长任务在跑。
    const runDone = vi.fn();
    const runPromise = remote.agent.run('long').then(runDone);
    await waitFor(() => parts.spies.run.mock.calls.length === 1);

    // 模拟网络断开;断线期间事件照发、任务照常完成。
    server.dropConnections();
    parts.bus.emit({ type: 'notice', level: 'info', message: 'while-offline-1' });
    parts.bus.emit({ type: 'notice', level: 'info', message: 'while-offline-2' });
    parts.runGate.resolve!();

    // 客户端自动重连(300ms 起)后全部补达。
    await waitFor(() => seen.includes('while-offline-2'), 5000);
    expect(seen).toContain('while-offline-1');
    await runPromise;
    expect(runDone).toHaveBeenCalled();
    await waitFor(() => remote.agent.isRunning === false);
    // 无缝路径:不许出现「记录不完整」的告警。
    expect(warns).not.toContain(t('notice.serverReconnected'));
  });

  it('缓冲滚过头:重连收到 gap,发告警并放弃重放', async () => {
    const { parts, server, remote } = await boot();
    const warns: string[] = [];
    const infos: string[] = [];
    remote.bus.on((event) => {
      if (event.type === 'notice' && event.level === 'warn') warns.push(event.message);
      if (event.type === 'notice' && event.level === 'info') infos.push(event.message);
    });

    server.dropConnections();
    // 超过 REPLAY_MAX_MESSAGES(1000)条,最早的必然被挤出缓冲。
    for (let i = 0; i < 1100; i += 1) {
      parts.bus.emit({ type: 'notice', level: 'info', message: `flood-${i}` });
    }

    await waitFor(() => warns.includes(t('notice.serverReconnected')), 5000);
    // 认输路径:最早的事件确实没有被重放。
    expect(infos).not.toContain('flood-0');
  });

  it('顺序依赖的调用按发起顺序到达(goalSet 先于 setPermissions)', async () => {
    const { parts, remote } = await boot();
    const order: string[] = [];
    parts.spies.goalSet.mockImplementation(() => order.push('set'));
    parts.spies.setPermissions.mockImplementation(() => order.push('perms'));
    remote.goal.set('all tests green');
    remote.setPermissions({ sandbox: 'read-only', approval: 'never' });
    await waitFor(() => order.length === 2);
    expect(order).toEqual(['set', 'perms']);
  });
});

/**
 * 乐观运行标志的乱序回归。
 *
 * 真 server 在环回下 ack 总是先于 call-result 到达,复现不了——这里手写一个
 * 最小协议 server,**故意把 ack 押后、完成回执先发**。那正是真实世界会出现
 * 的顺序:server 侧 `Agent.run` 撞上已在跑的轮次会立刻返回(loop.ts 的 inject
 * 快速返回路径),ack 与 call-result 几乎同时分两条连接发出,谁先到取决于
 * 内核与调度。
 *
 * 修复前的写法(ack 的 .then 里才置位乐观标志)在这个顺序下会:completion
 * 先兑现 → finally 清标志 → ack 的 .then 把它置回 true → 再无人清除。
 * isRunning 从此恒真,命令全被 busy 拦、esc 永远走中断、提交一律退化成
 * inject——会话等于废掉。
 */
describe('乐观运行标志(乱序回执)', () => {
  it('call-result 先于 ack 到达时不会永久锁死 isRunning', async () => {
    const token = 'test-token';
    const sse: ServerResponse[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/event') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(':ok\n\n');
        res.write(`data: ${JSON.stringify({ kind: 'state', state: minimalState() })}\n\n`);
        sse.push(res);
        return;
      }
      if (url.pathname === '/state') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(minimalState()));
        return;
      }
      if (url.pathname === '/history') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ messages: [] }));
        return;
      }
      // POST /call:先把完成回执从 SSE 推出去,再(延迟)回 ack。
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: string };
        for (const client of sse) {
          client.write(
            `data: ${JSON.stringify({ kind: 'call-result', callId: call.id, ok: true })}\n\n`,
          );
        }
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, deferred: true }));
        }, 60);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const remote = await connectRemote({
      url: `http://127.0.0.1:${port}`,
      token,
      ownsServer: false,
    });

    await remote.agent.run('quick');
    // ack 还没回来;等它落地之后再断言——修复前正是这一步把标志置回 true。
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(remote.agent.isRunning).toBe(false);
    expect(remote.goal.busy).toBe(false);

    await remote.dispose();
    for (const client of sse) client.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

function minimalState(): StateSnapshot {
  return {
    root: '/tmp/fake-root',
    provider,
    config,
    mcpStatuses: [],
    storeId: 's1',
    agent: { isRunning: false, isCompacting: false, historyLength: 0 },
    goal: { active: false, busy: false },
    todos: [],
    skills: [],
    sentAt: Date.now(),
  };
}

describe('isTrustedTransport(凭据过线的传输门槛)', () => {
  it('loopback 与 https 可信;明文远端与畸形 URL 一律拒绝', async () => {
    const { isTrustedTransport } = await import('../src/client/remote.js');
    expect(isTrustedTransport('http://127.0.0.1:7777')).toBe(true);
    expect(isTrustedTransport('http://localhost:7777')).toBe(true);
    expect(isTrustedTransport('http://[::1]:7777')).toBe(true);
    expect(isTrustedTransport('https://box.example.com')).toBe(true);
    // `serve --host` + `--attach` 的明文 HTTP:key 发出去等于广播。
    expect(isTrustedTransport('http://192.168.1.5:7777')).toBe(false);
    expect(isTrustedTransport('http://box.example.com:7777')).toBe(false);
    expect(isTrustedTransport('not-a-url')).toBe(false);
  });
});
