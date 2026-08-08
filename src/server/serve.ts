/**
 * mojocode server:把一个 bootstrap 出来的 `Session` 暴露成 HTTP 服务
 * (REST + SSE),TUI 作为瘦客户端连接——进程模型对齐 opencode。
 *
 * 路由:
 *  - `GET  /event`      SSE 下行流(state 快照 + AgentEvent + call-result)
 *  - `GET  /state`      当前状态快照(client 连接时的初始拉取)
 *  - `GET  /history`    当前内存历史(回退选择器 / 恢复回放的数据源)
 *  - `POST /call`       方法调用(见 protocol.ts;长任务 ack + SSE 回执)
 *  - `POST /permission` 授权决定回执
 *
 * 安全边界:只绑 127.0.0.1,所有请求校验 Bearer token——server 能执行任意
 * bash,不设 token 的话浏览器页面可以对 localhost 盲发 POST(表单编码不触发
 * 预检),等于把整台机器交给任意网页。token 经环境变量传给受管子进程,
 * 不走 argv(ps 可见)。
 *
 * 本模块只依赖 agent 核心与 node:http,无 UI 框架、无 FFI:server 在 Node ≥ 22
 * 上照常工作,TUI 的 FFI 运行时门只管 client 进程。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Session } from '../app/bootstrap.js';
import type { PermissionAsker, PermissionDecision, PermissionRequest } from '../core/events.js';
import {
  DEFERRED_METHODS,
  redactConfig,
  redactProvider,
  serializeEvent,
  snapshotKey,
  toWireError,
  type CallRequest,
  type CallResponse,
  type PermissionReply,
  type ServerMessage,
  type StateSnapshot,
} from './protocol.js';

/** SSE 心跳间隔:注释行,client 侧直接忽略。 */
const HEARTBEAT_MS = 30_000;

/** 重放缓冲上限(条数 + 字节双重封顶,理由见 broadcast 内注释)。 */
const REPLAY_MAX_MESSAGES = 1000;
const REPLAY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 不可能改变状态快照的事件类型——收到它们时跳过 computeState/snapshotKey。
 * 判据是「快照里的字段会不会变」:isRunning/isCompacting/historyLength、
 * 两轴权限与 plan、provider、mcpStatuses、storeId、todos、goal 统计。
 * 纯文本/思考的流式增量与起止标记一概不沾这些,而它们恰恰占了事件总量的
 * 绝大部分。step-end 刻意不在此列:它会推进 goal 的 token 统计。
 */
const STATE_NEUTRAL_EVENTS = new Set([
  'text-start',
  'text-delta',
  'text-end',
  'reasoning-start',
  'reasoning-delta',
  'reasoning-end',
]);

/**
 * 授权中介:gate 的 ask 回调落在这里,请求本身经 bus 的 permission-request
 * 事件(SSE)到达 client,决定经 `POST /permission` 回来。必须在 bootstrap
 * **之前**创建——bootstrap 构造 gate 时就要拿到 ask。
 */
export interface PermissionBroker {
  ask: PermissionAsker;
  /** 回执一个决定;id 无人等待时返回 false(重复回执 / 已被取消)。 */
  resolve(id: string, decision: PermissionDecision): boolean;
  /**
   * 尚未回执的请求(发起顺序)。新 SSE 连接接上来时要**重放**它们:
   * 请求只经一次广播送达,没有客户端在场的那一刻(client 崩了、
   * `--attach` 连上一个正跑到一半的 server、重连窗口)事件就永远丢了,
   * 而 gate 那边还在 await——工具调用连同整个轮次就此挂死,重连上来的
   * 客户端只看到 isRunning 为真却没有任何确认框。
   */
  pending(): PermissionRequest[];
}

export function createPermissionBroker(): PermissionBroker {
  const waiting = new Map<
    string,
    { request: PermissionRequest; resolve: (decision: PermissionDecision) => void }
  >();
  return {
    ask: (request) =>
      new Promise<PermissionDecision>((resolve) => {
        waiting.set(request.id, { request, resolve });
      }),
    resolve: (id, decision) => {
      const entry = waiting.get(id);
      if (!entry) return false;
      waiting.delete(id);
      entry.resolve(decision);
      return true;
    },
    pending: () => [...waiting.values()].map((entry) => entry.request),
  };
}

export interface ServeOptions {
  session: Session;
  broker: PermissionBroker;
  host?: string;
  /** 0(默认)= 系统分配临时端口。 */
  port?: number;
  /** 不传则自动生成并随返回值带出。 */
  token?: string;
  /** 收到 shutdown 调用时的宿主回调(受管模式下退出进程)。 */
  onShutdown?: () => void;
}

export interface RunningServer {
  url: string;
  token: string;
  close(): Promise<void>;
  /**
   * 强行掐断当前全部 SSE 连接(server 继续运行)。生产代码不用;测试靠它
   * 模拟网络中断——client 侧的重连与断点续传路径没有别的稳定触发方式。
   */
  dropConnections(): void;
}

export async function startServer(options: ServeOptions): Promise<RunningServer> {
  const { session, broker } = options;
  const host = options.host ?? '127.0.0.1';
  const token = options.token ?? randomBytes(24).toString('hex');
  const tokenBuf = Buffer.from(token);

  const sseClients = new Set<ServerResponse>();

  const computeState = (): StateSnapshot => {
    const goalStatus = session.goal.snapshot();
    return {
      root: session.root,
      provider: redactProvider(session.provider),
      config: redactConfig(session.config),
      mcpStatuses: session.mcpStatuses,
      storeId: session.store.id,
      agent: {
        isRunning: session.agent.isRunning,
        isCompacting: session.agent.isCompacting,
        historyLength: session.agent.history.length,
      },
      goal: {
        active: session.goal.active,
        busy: session.goal.busy,
        ...(goalStatus ? { status: goalStatus } : {}),
        ...(session.goal.state?.restored ? { restored: true } : {}),
      },
      todos: session.todos.get(),
      skills: session.skills,
      sentAt: Date.now(),
    };
  };

  // ---- 事件重放缓冲(SSE 标准的 id / Last-Event-ID 断点续传) ----
  //
  // 广播是一次性的:client 断线期间发出的 event / call-result 没有这层缓冲
  // 就永久丢失——时间线与退出 dump 缺一段还只是难看,断线窗口里落地的
  // call-result 丢掉是致命的:pendingCalls 里的 promise 永不 settle,
  // setRunning(false) 永远等不到。每条消息带单调递增的 id,重连的 client
  // 带 Last-Event-ID 回来,缓冲还在就无缝续上,滚过头才发 gap 认输。
  //
  // state 快照刻意不进缓冲、不占序号:连接时总是现算最新的,重放旧快照
  // 只是浪费带宽。
  let seq = 0;
  const replayBuffer: Array<{ seq: number; frame: string; bytes: number }> = [];
  let replayBytes = 0;

  const frameOf = (message: ServerMessage, id?: number): string =>
    `${id !== undefined ? `id: ${id}\n` : ''}data: ${JSON.stringify(message)}\n\n`;

  const broadcast = (message: ServerMessage): void => {
    let frame: string;
    if (message.kind === 'state') {
      frame = frameOf(message);
    } else {
      const id = ++seq;
      frame = frameOf(message, id);
      const bytes = Buffer.byteLength(frame);
      replayBuffer.push({ seq: id, frame, bytes });
      replayBytes += bytes;
      // 双重封顶:text-delta 多而小,按条数;tool-end 的 output 可能巨大,
      // 按字节。溢出丢最旧(至少留一条,免得一个超大帧把缓冲清成空转)。
      while (
        replayBuffer.length > 1 &&
        (replayBuffer.length > REPLAY_MAX_MESSAGES || replayBytes > REPLAY_MAX_BYTES)
      ) {
        const dropped = replayBuffer.shift()!;
        replayBytes -= dropped.bytes;
      }
    }
    for (const client of sseClients) client.write(frame);
  };

  // 状态推送带变化检测:事件风暴(每个 text-delta 都会触发重算)下,
  // 只有稳定键变了才真的推。
  let lastStateKey = '';
  const pushState = (): void => {
    const state = computeState();
    const key = snapshotKey(state);
    if (key === lastStateKey) return;
    lastStateKey = key;
    broadcast({ kind: 'state', state });
  };

  // 事件先行、状态随后:client 先看到事件(时间线落条目),再看到它引起的
  // 状态变化(isRunning、goal 计数等)。
  const offBus = session.bus.on((event) => {
    broadcast({ kind: 'event', event: serializeEvent(event) });
    // 流式增量不改变快照里的任何字段,直接跳过重算。变化检测省掉的只是
    // *广播*,computeState + snapshotKey 本身要 redact 整份配置再
    // JSON.stringify——挂在 text-delta 上就是每轮几千次全量序列化。
    if (!STATE_NEUTRAL_EVENTS.has(event.type)) pushState();
  });
  const offTodos = session.todos.subscribe(() => pushState());
  // 技能与 todos 同理:非总线驱动的快照字段,变化各自订阅推送。
  const offSkills = session.skillsChanged(() => pushState());

  /**
   * 立即返回结果的方法。抛错原样上抛,由调用处包成 WireError。
   * 参数逐处断言类型:调用方是我们自己的 client(token 已挡外人),线上
   * 形态与 SessionHandle 的签名一一对应。
   */
  const dispatch = async (method: string, rawArgs: unknown): Promise<unknown> => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'abort':
        session.agent.abort();
        return undefined;
      case 'inject':
        return session.agent.inject(args['text'] as string, args['images'] as never);
      case 'setHistory':
        session.agent.setHistory(args['messages'] as never);
        return undefined;
      case 'saveHistory':
        await session.store.save(args['messages'] as never);
        return undefined;
      case 'goalSet':
        session.goal.set(args['condition'] as string);
        return undefined;
      case 'goalClear':
        session.goal.clear(args['reason'] as never);
        return undefined;
      case 'goalSteer':
        return session.goal.steer(args['text'] as string, args['options'] as never);
      case 'setPermissions':
        session.setPermissions(args['permissions'] as never);
        return undefined;
      case 'setPlan':
        session.setPlan(args['active'] === true);
        return undefined;
      case 'setReasoningEffort':
        await session.setReasoningEffort(args['level'] as never);
        return undefined;
      case 'switch':
        return redactProvider(
          await session.switch({
            provider: args['provider'] as string | undefined,
            model: args['model'] as string | undefined,
          }),
        );
      case 'newSession':
        await session.newSession();
        return { id: session.store.id };
      case 'resumeSession':
        // ProviderSwitchError 原样上抛:name 会随 WireError 过线,client 据此
        // 复原类型(历史已载入,只是没切成模型——App 按降级提示处理)。
        await session.resumeSession(args['idOrPrefix'] as string);
        return { id: session.store.id };
      case 'forkSession': {
        const forked = await session.forkSession();
        return { id: forked.id };
      }
      case 'refreshEnvironment':
        await session.refreshEnvironment();
        return undefined;
      case 'refreshSkills':
        return session.refreshSkills();
      case 'listModels':
        return session.listModels();
      case 'doctor':
        return session.doctor({ offline: args['offline'] === true });
      case 'shutdown':
        // 先回执再关:调用方要拿到 ack 才知道 server 收到了。
        setTimeout(() => options.onShutdown?.(), 10);
        return undefined;
      default:
        throw new Error(`unknown method: ${method}`);
    }
  };

  /** 长任务:立即 ack,完成经 SSE call-result 回执。 */
  const startDeferred = (call: CallRequest): void => {
    const args = (call.args ?? {}) as Record<string, unknown>;
    const promise: Promise<unknown> =
      call.method === 'run'
        ? session.agent.run(args['text'] as string, args['options'] as never)
        : call.method === 'goalRun'
          ? session.goal.run(args['text'] as string, args['options'] as never)
          : call.method === 'runSkill'
            ? session.runSkill(
                args['name'] as string,
                args['args'] as string,
                args['options'] as never,
              )
            : session.agent.compact();
    void promise
      .then((value) => broadcast({ kind: 'call-result', callId: call.id, ok: true, value }))
      .catch((error: unknown) =>
        broadcast({ kind: 'call-result', callId: call.id, ok: false, error: toWireError(error) }),
      )
      .finally(() => pushState());
  };

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return false;
    const presented = Buffer.from(header.slice('Bearer '.length));
    return presented.length === tokenBuf.length && timingSafeEqual(presented, tokenBuf);
  };

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  };

  const server = createServer((req, res) => {
    void (async () => {
      if (!authorized(req)) {
        json(res, 401, { ok: false, error: { name: 'Unauthorized', message: 'bad token' } });
        return;
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /event') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write(':ok\n\n');
        sseClients.add(res);
        // 新连接立即喂全量状态,client 不必再单独拉一次。
        res.write(frameOf({ kind: 'state', state: computeState() }));

        // 断点续传:client 重连会带 Last-Event-ID(见 remote.ts 的 readSse)。
        // 三种去向——
        //  1. 序号还在缓冲里 → 无缝重放缺失的帧,client 全程无感;
        //  2. 缓冲已滚过头 / 序号来自另一个 server 实例 → 发 gap 认输,
        //     client 告警「记录不完整」并刷新镜像;
        //  3. 没带头(全新连接)→ 不重放。
        const rawLastId = req.headers['last-event-id'];
        const lastEventId = typeof rawLastId === 'string' ? Number(rawLastId) : NaN;
        const oldestBuffered = replayBuffer[0]?.seq ?? seq + 1;
        const seamless =
          Number.isFinite(lastEventId) && lastEventId >= oldestBuffered - 1 && lastEventId <= seq;
        if (seamless) {
          for (const entry of replayBuffer) {
            if (entry.seq > lastEventId) res.write(entry.frame);
          }
        } else if (Number.isFinite(lastEventId)) {
          res.write(frameOf({ kind: 'gap' }));
        }
        // 待决授权请求的重放只在**非无缝**路径需要(全新连接 / gap):无缝
        // 重放时确认框仍在 client 屏幕上,或已随缓冲帧补达;这里再发一遍
        // 会让 asker 被问两次。broker 是待决集的权威,与序号缓冲互为兜底
        // ——缓冲滚过头时授权请求也在丢失之列,靠这里救回来。
        if (!seamless) {
          for (const request of broker.pending()) {
            res.write(
              frameOf({ kind: 'event', event: serializeEvent({ type: 'permission-request', request }) }),
            );
          }
        }
        const heartbeat = setInterval(() => res.write(':hb\n\n'), HEARTBEAT_MS);
        req.on('close', () => {
          clearInterval(heartbeat);
          sseClients.delete(res);
        });
        return;
      }

      if (route === 'GET /state') {
        json(res, 200, computeState());
        return;
      }

      if (route === 'GET /history') {
        json(res, 200, { messages: session.agent.history });
        return;
      }

      if (route === 'POST /call') {
        const call = (await readBody(req)) as CallRequest;
        if (DEFERRED_METHODS.has(call.method)) {
          startDeferred(call);
          json(res, 200, { ok: true, deferred: true } satisfies CallResponse);
          pushState();
          return;
        }
        try {
          const value = await dispatch(call.method, call.args);
          json(res, 200, { ok: true, value } satisfies CallResponse);
        } catch (error) {
          json(res, 200, { ok: false, error: toWireError(error) } satisfies CallResponse);
        }
        pushState();
        return;
      }

      if (route === 'POST /permission') {
        const reply = (await readBody(req)) as PermissionReply;
        const accepted = broker.resolve(reply.id, reply.decision);
        json(res, 200, { ok: accepted });
        return;
      }

      json(res, 404, { ok: false, error: { name: 'NotFound', message: route } });
    })().catch((error: unknown) => {
      if (!res.headersSent) {
        json(res, 500, { ok: false, error: toWireError(error) });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://${host}:${address.port}`,
    token,
    dropConnections: () => {
      for (const client of sseClients) client.destroy();
      sseClients.clear();
    },
    close: async () => {
      offBus();
      offTodos();
      offSkills();
      for (const client of sseClients) client.end();
      sseClients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
