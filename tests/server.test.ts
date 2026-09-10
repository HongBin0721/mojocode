import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/core/events.js';
import type { StateSnapshot } from '../src/server/protocol.js';
import { t } from '../src/i18n/index.js';
import { startServer, type RunningServer } from '../src/server/serve.js';
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
  statusBar: [],
  timeline: 'full',
  goalMaxTurns: 10,
  providers: { kimi: { apiKey: 'super-secret' } },
  search: { backend: 'off', apiKey: 'search-secret' },
  mcpServers: {
    local: { type: 'stdio', command: 'gh-mcp', args: [], env: { GITHUB_TOKEN: 'ghp_secret' }, enabled: true },
    remote: { type: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer secret' }, enabled: true },
  },
} as unknown as Config;

type FakeParts = ReturnType<typeof fakeSession>;

function fakeSession() {
  const bus = new EventBus();
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
    setReasoningEffort: vi.fn(),
    runCommand: vi.fn(async () => {}),
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
      contextUsage: { used: 1234, window: 100_000 },
      run: spies.run,
      inject: spies.inject,
      abort: spies.abort,
      compact: vi.fn(async () => {}),
      setHistory: spies.setHistory,
    },
    gate: { setAsker: vi.fn() },
    extensionCommands: [{ name: 'goal', description: 'Keep working', argumentHint: '<condition> | clear' }],
    extensionStatus: [{ id: 'goal', text: '◎ goal 1/10', since: 1_000 }],
    extensionState: { todo: [{ content: 'a', status: 'pending' }] },
    extensionsChanged: vi.fn(() => () => {}),
    // 装配期提示:serve 在每个非无缝 SSE 连接上补发,少了它重连就炸。
    startupNotices: [],
    runCommand: spies.runCommand,
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
    startSimplify: spies.startSimplify,
    archiveSession: vi.fn(async (id: string, archived: boolean) => ({
      id,
      root: '/tmp/fake-root',
      title: 't',
      ...(archived ? { archivedAt: '2026-01-01T00:00:00.000Z' } : {}),
    })),
    renameSession: vi.fn(async (id: string, title: string) => ({ id, root: '/tmp/fake-root', title })),
    deleteSession: vi.fn(async () => {}),
    listFiles: vi.fn(async () => ({ files: ['a.ts', 'dir/b.ts'], truncated: false })),
    readFile: vi.fn(async (path: string) => ({
      ok: true,
      path,
      content: 'hello',
      size: 5,
      truncated: false,
    })),
    changedFiles: [{ path: 'src/x.ts', kind: 'modified', count: 2 }],
    switchBranch: vi.fn(async (name: string) => ({ ok: true, branch: name })),
    commitAll: vi.fn(async () => ({ ok: true, sha: 'a'.repeat(40) })),
    undoCommit: vi.fn(async () => ({ ok: true })),
    discardAll: vi.fn(async () => ({ ok: false, reason: 'no-repo' })),
    dispose: vi.fn(async () => {}),
  } as unknown as Session;

  return {
    session,
    bus,
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
  const server = await startServer({ session: parts.session });
  cleanups.push(() => server.close());
  const remote = await connectRemote({ url: server.url, token: server.token, ownsServer: false });
  cleanups.push(() => remote.dispose());
  return { parts, server, remote };
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

  it('扩展的结构化状态经 state 推送镜像到 client', async () => {
    const { remote } = await boot();
    expect(remote.extensionState).toEqual({ todo: [{ content: 'a', status: 'pending' }] });
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

  it('reviewTargets 即时返回;startSimplify 走 deferred,乐观 run 标志随完成清除', async () => {
    const { parts, remote } = await boot();

    // 分支列表(GUI 顶栏的分支切换器):普通即时 RPC。/review 已是扩展命令,
    // 它自己在会话进程里跑 git,不经这条线。
    const targets = await remote.reviewTargets();
    expect(parts.spies.reviewTargets).toHaveBeenCalledOnce();
    expect(targets.isRepo).toBe(true);
    expect(targets.branches).toEqual([{ name: 'feature', subject: 'first' }]);

    // /simplify 走 deferred 通道,乐观标志在 ack 之前同步置位、随完成清除。
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


  it('回退链路:setHistory 即时更新镜像并送达 server,save 随后', async () => {
    const { parts, remote } = await boot();
    const truncated: ModelMessage[] = [];
    remote.agent.setHistory(truncated);
    expect(remote.agent.history).toBe(truncated);
    await remote.store.save(truncated);
    await waitFor(() => parts.spies.setHistory.mock.calls.length === 1);
    expect(parts.spies.save).toHaveBeenCalled();
  });

  // contextUsage 经 state 快照过线:--attach 与恢复会话后计量条立即有读数。
  it('state 快照携带 contextUsage,镜像可读', async () => {
    const { remote } = await boot();
    expect(remote.agent.contextUsage).toEqual({ used: 1234, window: 100_000 });
  });

  it('setHistory 的镜像即时估算上下文占用,不等 server 的权威帧', async () => {
    const { remote } = await boot();
    remote.agent.setHistory([{ role: 'user', content: '你好世界' }]);
    // CJK 按字符 1:1 估算:4 个汉字 4 token——为 0 就是退化回了旧行为。
    expect(remote.agent.contextUsage.used).toBe(4);
    expect(remote.agent.contextUsage.window).toBe(128_000);
  });

  it('resumeSession 的 ProviderSwitchError 过线后类型复原', async () => {
    const { remote } = await boot();
    await expect(remote.resumeSession('deadbeef')).rejects.toBeInstanceOf(ProviderSwitchError);
  });

  it('listSessions:按工作区过滤、updatedAt 倒序(GUI 侧栏数据源)', async () => {    const home = mkdtempSync(join(tmpdir(), 'mojocode-listsessions-'));
    const dir = join(home, '.mojocode', 'sessions');
    mkdirSync(dir, { recursive: true });
    const meta = (id: string, root: string, updatedAt: string, title: string) => {
      writeFileSync(join(dir, `${id}.jsonl`), '');
      writeFileSync(
        join(dir, `${id}.meta.json`),
        JSON.stringify({
          id,
          root,
          provider: 'kimi',
          model: 'kimi-k2',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt,
          title,
          messageCount: 2,
        }),
      );
    };
    meta('sess-old', '/tmp/fake-root', '2026-01-01T00:00:00Z', 'first');
    meta('sess-new', '/tmp/fake-root', '2026-01-02T00:00:00Z', 'second');
    meta('sess-other', '/other/root', '2026-01-03T00:00:00Z', '别的仓库');
    vi.stubEnv('HOME', home);
    try {
      const { remote } = await boot();
      const sessions = await remote.listSessions();
      expect(sessions.map((m) => m.id)).toEqual(['sess-new', 'sess-old']);
      expect(sessions[0]).toMatchObject({ title: 'second', root: '/tmp/fake-root', messageCount: 2 });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('workspaceStatus/fileDiff:GUI Review 面板的只读 RPC 过线', async () => {
    // dispatch 直接调收集器(读 session.root,不经 Session 成员),fake 的
    // root 是 /tmp/fake-root(非 git 仓库)——协议层验证 RPC 通与失败形状,
    // 数据正确性由 tests/workspace.test.ts 的真实 git 夹具覆盖。
    const { remote } = await boot();
    const status = await remote.workspaceStatus();
    expect(status).toMatchObject({ ok: false, entries: [], additions: 0, deletions: 0 });

    const diff = await remote.fileDiff('a.ts');
    expect(diff).toMatchObject({ ok: false, reason: 'no-repo', path: 'a.ts' });
  });

  it('会话生命周期与文件树 RPC 过线;changedFiles 进快照镜像', async () => {
    const { remote, parts } = await boot();

    const archived = await remote.archiveSession('s-1', true);
    expect(archived.archivedAt).toBe('2026-01-01T00:00:00.000Z');
    expect((parts.session.archiveSession as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      's-1',
      true,
    ]);

    const renamed = await remote.renameSession('s-1', '新标题');
    expect(renamed.title).toBe('新标题');

    await remote.deleteSession('s-2');
    expect((parts.session.deleteSession as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['s-2']);

    const files = await remote.listFiles();
    expect(files).toEqual({ files: ['a.ts', 'dir/b.ts'], truncated: false });

    const content = await remote.readFile('a.ts');
    expect(content).toMatchObject({ ok: true, path: 'a.ts', content: 'hello' });

    // 任务级变更索引来自 StateSnapshot 的镜像(旧 server 缺省时回退空表)。
    expect(remote.changedFiles).toEqual([{ path: 'src/x.ts', kind: 'modified', count: 2 }]);
  });

  it('git 写操作 RPC 过线,reason 码原样返回', async () => {
    const { remote, parts } = await boot();
    expect(await remote.switchBranch('feature')).toMatchObject({ ok: true, branch: 'feature' });
    expect((parts.session.switchBranch as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      'feature',
    ]);
    expect(await remote.commitAll('msg')).toMatchObject({ ok: true });
    expect(await remote.undoCommit()).toMatchObject({ ok: true });
    expect(await remote.discardAll()).toMatchObject({ ok: false, reason: 'no-repo' });
  });

  it('tool-output-delta 是瞬态帧:到达 client 总线,但断线期间的不重放', async () => {
    const { parts, server, remote } = await boot();
    const chunks: string[] = [];
    remote.bus.on((event) => {
      if (event.type === 'tool-output-delta') chunks.push(event.chunk);
    });

    parts.bus.emit({ type: 'tool-output-delta', callId: 'c1', chunk: 'live' });
    await waitFor(() => chunks.includes('live'));

    // 断线窗口内的 delta 不进重放缓冲;用一条普通事件确认重连已完成。
    const seen: string[] = [];
    remote.bus.on((event) => {
      if (event.type === 'notice') seen.push(event.message);
    });
    server.dropConnections();
    parts.bus.emit({ type: 'tool-output-delta', callId: 'c1', chunk: 'offline' });
    parts.bus.emit({ type: 'notice', level: 'info', message: 'after-delta' });
    await waitFor(() => seen.includes('after-delta'), 5000);
    expect(chunks).not.toContain('offline');
  });

  it('装配期提示补发给新连上的 client,且不因"还没人订阅"而丢失', async () => {
    // 装配期的警告(磁盘扩展加载失败之类)产生于 bootstrap 内部:那一刻
    // serve 还没 bus.on、client 更没连上。两处都要接住——server 在每个
    // 非无缝 SSE 连接上补发,client 在第一个订阅者接上前先排队(渲染层要到
    // connectRemote 返回、App 挂载之后才订阅,补发帧早就到了)。
    const parts = fakeSession();
    (parts.session as unknown as { startupNotices: unknown[] }).startupNotices = [
      { level: 'warn', message: 'extension foo failed to load' },
    ];
    const { remote } = await boot(parts);
    // 刻意等补发帧先到,再订阅——真实时序就是 connectRemote 返回之后 App
    // 才挂载;不睡这一下,帧比订阅晚到,client 侧的排队根本没被考到。
    await new Promise((resolve) => setTimeout(resolve, 60));
    const seen: string[] = [];
    remote.bus.on((event) => {
      if (event.type === 'notice') seen.push(event.message);
    });
    await waitFor(() => seen.includes('extension foo failed to load'));
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

  // sidecar 意外退出的快速通道:spawn 侧 onExit 回调 → notifyServerExit,
  // 不等 5 次重连白烧几秒。死因文本(退出码 + stderr 尾部)原样进 bus 的
  // 不可恢复 error;挂起的 deferred 调用一并 reject,spinner 不会常亮。
  it('notifyServerExit:立即断线、死因进 bus、pending 调用被 reject', async () => {
    const { parts, remote } = await boot();
    const errors: string[] = [];
    remote.bus.on((event) => {
      if (event.type === 'error' && !event.recoverable) errors.push(event.error.message);
    });

    const runPromise = remote.agent.run('long');
    await waitFor(() => parts.spies.run.mock.calls.length === 1);

    remote.notifyServerExit('server died: boom\ntail-line');

    await expect(runPromise).rejects.toThrow('server died: boom');
    expect(errors).toEqual(['server died: boom\ntail-line']);
  });

  // 计划内退出(dispose 已把连接标成 closed)之后到达的 exit 回调必须静默:
  // 正常退出不该在时间线里留下一条「server 意外退出」。
  it('notifyServerExit:dispose 之后是无操作', async () => {
    const { remote } = await boot();
    const errors: string[] = [];
    remote.bus.on((event) => {
      if (event.type === 'error') errors.push(event.error.message);
    });

    await remote.dispose();
    remote.notifyServerExit('late exit');
    expect(errors).toEqual([]);
  });

  it('顺序依赖的调用按发起顺序到达(runCommand 先于 setReasoningEffort)', async () => {
    const { parts, remote } = await boot();
    const order: string[] = [];
    parts.spies.runCommand.mockImplementation(async () => {
      order.push('cmd');
    });
    parts.spies.setReasoningEffort.mockImplementation(() => order.push('effort'));
    void remote.runCommand('goal', 'all tests green');
    void remote.setReasoningEffort('high');
    await waitFor(() => order.length === 2);
    expect(order).toEqual(['cmd', 'effort']);
    expect(parts.spies.runCommand).toHaveBeenCalledWith('goal', 'all tests green');
  });

  it('扩展的命令表与状态行随快照镜像;since 按 sentAt 校到本地时钟', async () => {
    const { remote } = await boot();
    expect(remote.extensionCommands).toEqual([
      { name: 'goal', description: 'Keep working', argumentHint: '<condition> | clear' },
    ]);
    const [status] = remote.extensionStatus;
    expect(status).toMatchObject({ id: 'goal', text: '◎ goal 1/10' });
    // server 报的 since 是 1_000(它的时钟);镜像加上"收到时刻 − sentAt"的偏差,
    // 结果应落在本地时钟上——即近似 Date.now() − (sentAt − 1_000)。
    expect(Math.abs(status!.since! - (Date.now() - (remote.snapshot.sentAt - 1_000)))).toBeLessThan(2_000);
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
    storeId: 's1',
    agent: { isRunning: false, isCompacting: false, historyLength: 0 },
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
