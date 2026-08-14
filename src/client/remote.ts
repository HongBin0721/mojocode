/**
 * 远程会话:TUI 侧的瘦客户端(进程模型对齐 opencode)。
 *
 * 把 server(src/server/serve.ts)镜像成一个结构性满足 `SessionHandle` 的
 * 对象,App.tsx 对本地 Session 与远程会话零区分:
 *
 *  - **同步读取**(isRunning、权限、provider、todos、goal、历史)从 SSE 驱动
 *    的本地镜像取——server 在任何状态变化时推送 state 快照;
 *  - **方法调用**走 `POST /call`,并经内部队列**串行化**:App 里存在
 *    `goal.set(...)` 紧跟 `goal.run(...)` 这类顺序依赖,两条 fetch 并发出去
 *    可能乱序到达;
 *  - **长任务**(run / goalRun / compact)POST 只拿 ack,完成回执经 SSE
 *    call-result 送达——它们可能一跑几小时,长连接会被各层 HTTP 超时斩断;
 *  - **授权**:permission-request 事件照常经 bus 到达 App(渲染确认框),
 *    镜像同时调用 setAsker 注册的回调拿决定,回执 `POST /permission`。
 *
 * 乐观运行标志:`run`/`goalRun` 的 ack 与 state 推送之间有一个来回的窗口,
 * 镜像里 isRunning 仍是 false——期间二次提交会误开新轮、esc 会误开回退
 * 选择器。ack 即置乐观位,首次看到 server 报 isRunning=true(状态已权威)
 * 或任务完成时清除。
 */

import type { ModelMessage } from 'ai';
import {
  EventBus,
  type PermissionAsker,
  type PermissionDecision,
  type PermissionRequest,
} from '../core/events.js';
import type { Config, Permissions, ReasoningEffort } from '../config/schema.js';
import type { ResolvedProvider } from '../config/load.js';
import type { McpStatus } from '../mcp/client.js';
import type { TodoItem } from '../tools/index.js';
import type { GoalState, GoalStatus } from '../agent/goal.js';
import type { GoalStopReason } from '../core/events.js';
import type { ModelInfo } from '../model/registry.js';
import type { DoctorReport } from '../app/doctor.js';
import type { SkillCommandInfo } from '../skills/discovery.js';
import { ProviderSwitchError } from '../app/bootstrap.js';
import type { RunOptions, SessionHandle } from '../app/session-handle.js';
import {
  DEFERRED_METHODS,
  deserializeEvent,
  type CallRequest,
  type CallResponse,
  type ServerMessage,
  type StateSnapshot,
} from '../server/protocol.js';
import { t } from '../i18n/index.js';

/** SSE 断线后的重连节奏。受管子进程死掉时重连注定失败,几次就够。 */
const RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 300;

/**
 * 凭据是否允许经这条连接发出:https 或 loopback(受管子进程/本机 serve)。
 * 解析失败按不可信处理——发 key 这件事宁可误拒。导出仅为测试。
 */
export function isTrustedTransport(serverUrl: string): boolean {
  try {
    const parsed = new URL(serverUrl);
    if (parsed.protocol === 'https:') return true;
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export interface RemoteOptions {
  url: string;
  token: string;
  /**
   * server 是本进程拉起的受管子进程时为真:dispose 要发 shutdown 让它退出。
   * `--attach` 到外部 server 时为假——退出 TUI 不该拖垮别人的 server。
   */
  ownsServer: boolean;
}

export interface RemoteSession extends SessionHandle {
  /** 仅测试/诊断用:当前镜像快照。 */
  readonly snapshot: StateSnapshot;
}

export async function connectRemote(options: RemoteOptions): Promise<RemoteSession> {
  const { url, token } = options;
  const headers = { authorization: `Bearer ${token}` };
  const bus = new EventBus();

  const fetchJson = async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await fetch(`${url}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
    if (!res.ok) throw new Error(`server ${res.status} on ${path}`);
    return res.json();
  };

  // ---- 镜像状态 ----
  let state = (await fetchJson('/state')) as StateSnapshot;
  // 展示历史(压缩不缩减)与模型历史一起镜像;旧 server 没有该字段,
  // 回退到模型历史(回放会把摘要显示成一行压缩提示,与旧行为一致)。
  let history: ModelMessage[] = [];
  let displayHistory: ModelMessage[] = [];
  const applyHistory = (payload: { messages: ModelMessage[]; displayMessages?: ModelMessage[] }) => {
    history = payload.messages;
    displayHistory = payload.displayMessages ?? payload.messages;
  };
  applyHistory((await fetchJson('/history')) as { messages: ModelMessage[] });
  let closed = false;

  // 乐观运行标志(见文件头注释)。
  const optimistic = { run: false, goal: false, compact: false };

  // todos 迷你 store:App 用 get/subscribe,变化来自 state 推送。
  let todoItems: TodoItem[] = state.todos;
  const todoListeners = new Set<(items: TodoItem[]) => void>();
  // skills 同款迷你 store(App 的命令菜单靠它感知列表变化)。老 server 的
  // 快照没有 skills 字段,镜像为一律空表。
  let skillItems = state.skills ?? [];
  const skillListeners = new Set<() => void>();
  const applyState = (next: StateSnapshot): void => {
    state = next;
    if (next.agent.isRunning) optimistic.run = false;
    if (next.goal.busy) optimistic.goal = false;
    if (next.agent.isCompacting) optimistic.compact = false;
    if (JSON.stringify(next.todos) !== JSON.stringify(todoItems)) {
      todoItems = next.todos;
      for (const listener of todoListeners) listener(todoItems);
    }
    const nextSkills = next.skills ?? [];
    if (JSON.stringify(nextSkills) !== JSON.stringify(skillItems)) {
      skillItems = nextSkills;
      for (const listener of skillListeners) listener();
    }
  };

  // ---- 历史刷新(带在途合并) ----
  let historyFetching = false;
  let historyDirty = false;
  const refreshHistory = async (): Promise<void> => {
    if (historyFetching) {
      historyDirty = true;
      return;
    }
    historyFetching = true;
    try {
      do {
        historyDirty = false;
        applyHistory((await fetchJson('/history')) as { messages: ModelMessage[] });
      } while (historyDirty);
    } catch {
      // 尽力而为:断线时由 SSE 侧统一报错,这里不重复。
    } finally {
      historyFetching = false;
    }
  };
  const refreshState = async (): Promise<void> => {
    try {
      applyState((await fetchJson('/state')) as StateSnapshot);
    } catch {
      // 同上。
    }
  };

  // ---- 调用通道 ----
  let callCounter = 0;
  const nextCallId = (): string => `c${++callCounter}-${Date.now()}`;
  const pendingCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const reviveError = (wire: { name: string; message: string }): Error => {
    if (wire.name === 'ProviderSwitchError') {
      return new ProviderSwitchError(new Error(wire.message));
    }
    const error = new Error(wire.message);
    error.name = wire.name;
    return error;
  };

  // 串行化队列:保证调用按 App 的发起顺序到达 server。
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const postCall = async (call: CallRequest): Promise<CallResponse> => {
    const res = await fetch(`${url}/call`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(call),
    });
    if (!res.ok) throw new Error(`server ${res.status} on /call ${call.method}`);
    return (await res.json()) as CallResponse;
  };

  /** 即时方法:排队 POST,直接拿返回值。 */
  const call = async <T>(method: string, args?: unknown): Promise<T> => {
    const response = await enqueue(() => postCall({ id: nextCallId(), method, args }));
    if (!response.ok) throw reviveError(response.error);
    return response.value as T;
  };

  /** 长任务:排队 POST 拿 ack,完成等 SSE call-result。 */
  const callDeferred = (method: string, args?: unknown): Promise<unknown> => {
    const id = nextCallId();
    const completion = new Promise<unknown>((resolve, reject) => {
      pendingCalls.set(id, { resolve, reject });
    });
    // 完成回执的历史刷新挂在 completion 上,ack 失败时一并收尾。
    const settled = completion.finally(() => {
      if (method === 'run' || method === 'goalRun' || method === 'runSkill') {
        optimistic.run = false;
        optimistic.goal = false;
      }
      if (method === 'compact') optimistic.compact = false;
      void refreshHistory();
    });
    // 乐观运行标志在**发起前**同步置位,不能等 ack 的 .then:server 侧
    // Agent.run 有快速返回路径(已在跑时转 inject 立即兑现,loop.ts:244),
    // 那时 call-result 帧可能先于 ack 的 fetch promise 落地——上面的 finally
    // 先清了标志,ack 的 .then 再把它置回 true,就永远没人清了。isRunning
    // 从此恒为真:命令全被 busy 拦、esc 永远走中断、提交一律退化成 inject。
    // runSkill 同样占 run 标志:它就是一整轮 agent.run,漏了这里就复现
    // "ack 迟到把标志置回、永远没人清"的卡死。
    if (method === 'run' || method === 'runSkill') optimistic.run = true;
    if (method === 'goalRun') {
      optimistic.run = true;
      optimistic.goal = true;
    }
    if (method === 'compact') optimistic.compact = true;
    void enqueue(() => postCall({ id, method, args }))
      .then((response) => {
        // ack 失败(HTTP 层错误在 enqueue 的 rejection 里,协议层错误在这):
        // 抛给下面的 catch 统一 reject completion,不能在这里删 pending——
        // 删了 catch 就找不到 resolver,completion 永不 settle。
        if (!response.ok) throw reviveError(response.error);
        return undefined;
      })
      .catch((error: Error) => {
        const entry = pendingCalls.get(id);
        pendingCalls.delete(id);
        entry?.reject(error);
      });
    return settled;
  };

  // ---- 授权桥 ----
  let asker: PermissionAsker | undefined;
  /**
   * asker 注册之前到达的授权请求。connectRemote 早在 App 挂载(才调
   * setAsker)之前就返回了,而 `--attach` 连上的 server 可能正跑到一半、
   * 一接上就重放待决请求——直接丢弃的话 server 侧的 gate 会一直 await,
   * 整轮挂死。这里先排队,setAsker 时补发。
   */
  const askerQueue: PermissionRequest[] = [];
  /** 问一次并把决定回执给 server;重复到达的同一 id 由 server 侧幂等吸收。 */
  const askPermission = (request: PermissionRequest): void => {
    void Promise.resolve(asker!(request)).then((decision) =>
      answerPermission(request.id, decision),
    );
  };

  const answerPermission = (id: string, decision: PermissionDecision): void => {
    void enqueue(() =>
      fetch(`${url}/permission`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ id, decision }),
      }),
    ).catch(() => {
      // 断线时由 SSE 侧统一报错。
    });
  };

  // ---- SSE 下行流 ----
  const sseAbort = new AbortController();
  const handleMessage = (message: ServerMessage): void => {
    if (message.kind === 'state') {
      applyState(message.state);
      return;
    }
    if (message.kind === 'call-result') {
      const entry = pendingCalls.get(message.callId);
      if (!entry) return;
      pendingCalls.delete(message.callId);
      if (message.ok) entry.resolve(message.value);
      else entry.reject(reviveError(message.error!));
      return;
    }
    if (message.kind === 'gap') {
      // server 的重放缓冲救不回断线期间的事件了:时间线与退出 dump 会缺
      // 一段,明说,别让用户对着一份静默残缺的记录。镜像顺手刷新——
      // 持久化过的部分(历史)还是补得回来的。
      bus.emit({ type: 'notice', level: 'warn', message: t('notice.serverReconnected') });
      void refreshHistory();
      void refreshState();
      return;
    }
    const event = deserializeEvent(message.event);
    bus.emit(event);
    // 授权询问:事件已经让 App 弹出确认框;这里拿 setAsker 注册的回调等决定,
    // 回执给 server。与本地模式同构(gate 那边 emit 之后调用 ask)。
    if (event.type === 'permission-request') {
      if (asker) askPermission(event.request);
      else askerQueue.push(event.request);
    }
    // 历史随轮次推进:turn-end 时 server 侧已把本轮增量并进内存历史。
    if (
      event.type === 'turn-end' ||
      event.type === 'aborted' ||
      event.type === 'compaction' ||
      (event.type === 'error' && !event.recoverable)
    ) {
      void refreshHistory();
    }
  };

  const connectionLost = (): void => {
    if (closed) return;
    closed = true;
    sseReady.reject(new Error(t('notice.serverLost'))); // 已兑现时是无操作

    for (const [, entry] of pendingCalls) {
      entry.reject(new Error(t('notice.serverLost')));
    }
    pendingCalls.clear();
    bus.emit({ type: 'error', error: new Error(t('notice.serverLost')), recoverable: false });
  };

  // connectRemote 必须等首条 SSE 连接**就位**才返回:server 在响应头发出前
  // 就把连接记入广播列表,所以 fetch 兑现 = 之后的事件不会再丢。不等的话,
  // 调用方拿到会话立刻发起的操作(甚至首个 permission-request)会广播给
  // 零个客户端,永久丢失。
  let sseReady!: { resolve: () => void; reject: (e: Error) => void };
  const sseReadyPromise = new Promise<void>((resolve, reject) => {
    sseReady = { resolve, reject };
  });
  /**
   * 已收到的最后一条带序号消息的 id(SSE 标准语义)。重连时以
   * Last-Event-ID 送回,server 的重放缓冲还在就无缝续上——断线期间的
   * event / call-result 一条不丢;缓冲滚过头 server 才发 gap,那时再告警。
   * 一条带序号的消息都没收过也要送 0:「从头给我」与「全新连接」不同,
   * 后者不重放。
   */
  let lastSeq: number | undefined;
  const readSse = async (): Promise<void> => {
    let attempt = 0;
    let everConnected = false;
    while (!closed) {
      try {
        const resumeHeaders =
          everConnected ? { ...headers, 'last-event-id': String(lastSeq ?? 0) } : headers;
        const res = await fetch(`${url}/event`, { headers: resumeHeaders, signal: sseAbort.signal });
        if (!res.ok || !res.body) throw new Error(`server ${res.status} on /event`);
        everConnected = true;
        attempt = 0;
        sseReady.resolve();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep = buffer.indexOf('\n\n');
          while (sep !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let frameId: number | undefined;
            for (const line of frame.split('\n')) {
              if (line.startsWith('id: ')) {
                const parsed = Number(line.slice(4));
                if (Number.isFinite(parsed)) frameId = parsed;
              } else if (line.startsWith('data: ')) {
                handleMessage(JSON.parse(line.slice(6)) as ServerMessage);
              }
            }
            // 帧处理完才推进 lastSeq:处理中途断线的话,这一帧要重收。
            if (frameId !== undefined) lastSeq = frameId;
            sep = buffer.indexOf('\n\n');
          }
        }
        // 流正常结束 = server 关闭。走重连;彻底失败由下面统一收尾。
        throw new Error('event stream ended');
      } catch (error) {
        if (closed || sseAbort.signal.aborted) return;
        attempt += 1;
        if (attempt > RECONNECT_ATTEMPTS) {
          connectionLost();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_BASE_MS * attempt));
        // 重连后 server 立刻推全量 state,缺失的事件按 Last-Event-ID 重放;
        // 历史再拉一次只是镜像保鲜,无缝路径下不是必需。
        void refreshHistory();
      }
    }
  };
  void readSse();
  await sseReadyPromise;

  // ---- goal 镜像 ----
  const goalStatus = (): GoalStatus | undefined => {
    const status = state.goal.status;
    if (!status) return undefined;
    // server 侧的计时在流逝,按快照年龄外推;轮数/判词等离散值等推送更新。
    return { ...status, elapsedMs: status.elapsedMs + Math.max(0, Date.now() - state.sentAt) };
  };
  const goalState = (): Readonly<GoalState> | undefined => {
    const status = state.goal.status;
    if (!status) return undefined;
    return {
      condition: status.condition,
      startedAt: state.sentAt - status.elapsedMs,
      turns: status.turns,
      lastReason: status.lastReason,
      tokenBaseline: 0,
      evaluatorTokens: 0,
      restored: status.restored,
    };
  };

  const remote: RemoteSession = {
    get snapshot() {
      return state;
    },
    root: state.root,
    get config() {
      return state.config as Config;
    },
    get provider() {
      return state.provider as ResolvedProvider;
    },
    bus,
    agent: {
      get isRunning() {
        return state.agent.isRunning || optimistic.run;
      },
      get isCompacting() {
        return state.agent.isCompacting || optimistic.compact;
      },
      get history() {
        return history;
      },
      run: (text, options) => callDeferred('run', { text, options }).then(() => undefined),
      inject: (text, images) => call<boolean>('inject', { text, images }),
      abort: () => {
        void call('abort').catch(() => {});
      },
      compact: () => callDeferred('compact').then(() => undefined),
      setHistory: (messages) => {
        // 镜像即时更新:回退选择器选完立刻要读 agent.history 重放时间线。
        // 展示历史同步截尾(rewind 是真删,server 侧的 store 也会这么做);
        // 随后的 refreshHistory 会用 server 的权威版本覆盖。
        const removed = history.length - messages.length;
        if (removed > 0 && removed <= displayHistory.length) {
          displayHistory = displayHistory.slice(0, displayHistory.length - removed);
        }
        history = messages;
        void call('setHistory', { messages }).catch(() => {});
      },
    },
    gate: {
      setAsker: (ask) => {
        asker = ask;
        // 注册前排队的请求补发(见 askerQueue 的注释)。
        const queued = askerQueue.splice(0, askerQueue.length);
        for (const request of queued) askPermission(request);
      },
    },
    todos: {
      get: () => todoItems,
      subscribe: (listener) => {
        todoListeners.add(listener);
        return () => todoListeners.delete(listener);
      },
    },
    goal: {
      get active() {
        return state.goal.active;
      },
      get busy() {
        return state.goal.busy || optimistic.goal;
      },
      get state() {
        return goalState();
      },
      set: (condition) => {
        void call('goalSet', { condition }).catch(() => {});
      },
      clear: (reason?: GoalStopReason) => {
        void call('goalClear', { reason }).catch(() => {});
      },
      snapshot: goalStatus,
      steer: (text, options?: RunOptions) => call<boolean>('goalSteer', { text, options }),
      run: (text, options) => callDeferred('goalRun', { text, options }).then(() => undefined),
    },
    get mcpStatuses() {
      return state.mcpStatuses;
    },
    store: {
      get id() {
        return state.storeId;
      },
      get messages() {
        return history;
      },
      get displayMessages() {
        return displayHistory;
      },
      save: (messages) => call('saveHistory', { messages }),
    },
    newSession: async () => {
      const result = await call<{ id: string }>('newSession');
      history = [];
      displayHistory = [];
      await refreshState();
      return result;
    },
    resumeSession: async (idOrPrefix) => {
      try {
        return await call<{ id: string }>('resumeSession', { idOrPrefix });
      } finally {
        // ProviderSwitchError 时历史其实已载入(server 侧语义),镜像照样刷新,
        // App 才能按"已恢复但没换成模型"降级处理。
        await Promise.all([refreshState(), refreshHistory()]);
      }
    },
    forkSession: () => call<{ id: string }>('forkSession'),
    switch: async (change) => {
      // 刚就地输入的 key 只允许在可信传输上过线:loopback(受管子进程的默认
      // 形态)或 https。`serve --host` + `--attach` 是明文 HTTP,把 key 发出去
      // 等于广播——宁可拒绝并让用户在 server 侧配置。
      if (change.apiKey !== undefined && !isTrustedTransport(url)) {
        throw new Error(t('remote.keyRefusedInsecure'));
      }
      const next = await call<ResolvedProvider>('switch', change);
      await refreshState();
      return next;
    },
    setPermissions: (permissions: Permissions) => {
      // 乐观镜像:App 紧接着会读 config.sandbox/approval(shift+tab 循环步进
      // 就是拿它算下一档);等 state 推送会慢一拍,连按两次会在同一档打转。
      state = {
        ...state,
        config: { ...state.config, sandbox: permissions.sandbox, approval: permissions.approval, plan: false },
      };
      void call('setPermissions', { permissions }).catch(() => {});
    },
    setPlan: (active: boolean) => {
      state = { ...state, config: { ...state.config, plan: active } };
      void call('setPlan', { active }).catch(() => {});
    },
    setReasoningEffort: (level: ReasoningEffort) => {
      state = { ...state, provider: { ...state.provider, reasoningEffort: level } };
      return call<void>('setReasoningEffort', { level });
    },
    listModels: () => call<ModelInfo[]>('listModels'),
    doctor: (opts) => call<DoctorReport>('doctor', opts),
    refreshEnvironment: () => call<void>('refreshEnvironment'),
    get skills() {
      return skillItems;
    },
    skillsChanged: (listener: () => void) => {
      skillListeners.add(listener);
      return () => skillListeners.delete(listener);
    },
    refreshSkills: async () => {
      const list = await call<SkillCommandInfo[]>('refreshSkills');
      // RPC 返回值直接更新镜像:随后的 state 推送内容相同,diff 后静默。
      skillItems = list;
      for (const listener of skillListeners) listener();
      return list;
    },
    // deferred:一整轮 agent.run,乐观 run 标志的置位/清除见 callDeferred。
    runSkill: (name, args, opts) =>
      callDeferred('runSkill', { name, args, options: opts }).then(() => undefined),
    dispose: async () => {
      const wasClosed = closed;
      closed = true;
      if (options.ownsServer && !wasClosed) {
        // 必须限时:shutdown 走同一条串行队列,前面可能正排着一个慢调用
        // (/model 的 listModels、/doctor 的联网探测,两者都不在 busy 拦截
        // 名单里),而 fetch 本身也没有超时。dispose 是在主屏已还原之后
        // await 的——一旦卡住,用户面对的是一个冻住的终端。超时就放手,
        // 受管子进程还有 stdin EOF 与 ppid 看门狗两道兜底。
        await Promise.race([
          call('shutdown').catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      }
      sseAbort.abort();
    },
  };
  return remote;
}

/** 供 cli 判断 deferred 集合是否与协议一致(测试用途)。 */
export { DEFERRED_METHODS };
