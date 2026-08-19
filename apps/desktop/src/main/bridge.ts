/**
 * IPC 桥:把 main 进程里的 RemoteSession 镜像暴露给 renderer。
 *
 * 职责与通道见 src/shared/ipc.ts 的契约注释。两处合并是性能关键:
 *  - 事件:同一微任务内的 AgentEvent 合并成一次 send(text-delta 风暴下
 *    每帧可能几十条,逐条过 IPC 会卡 renderer 的 commit);
 *  - 状态:三源触发(每个 bus 事件 / todos.subscribe / skillsChanged)后
 *    微任务合并,再经 snapshotKey 去重——语义对齐 serve.ts 的 pushState
 *    (server 侧靠 STATE_NEUTRAL_EVENTS 跳过重算;客户端拿到的事件流相同,
 *    每事件后重算一次 key 的代价远低于整份快照过 IPC)。
 *
 * 本模块**不注册 ipcMain.handle**——那是 index.ts 的事:它必须在 app ready
 * 就注册 handler(否则 renderer 加载完成早于 server 握手时,subscribe 会
 * 打到「No handler registered」),handler 内部 await 本桥就绪。桥自身只
 * 通过注入的 target 下发推送,测试无需 mock electron。
 */

import type { AgentEvent, PermissionDecision, PermissionRequest } from '@core/events';
import type { RemoteSession } from '@core/remote';
import { serializeEvent, snapshotKey, type StateSnapshot } from '@core/protocol';
import type { TimelineItem } from '@core/types';
import { IPC_CHANNELS } from '../shared/ipc.js';
import type { ConnectionState, RpcRequest } from '../shared/ipc.js';

/** BrowserWindow.webContents 的最小形状。 */
export interface BridgeTarget {
  send(channel: string, ...args: unknown[]): void;
}

export interface BridgeDeps {
  /** 本桥所属任务(= 会话 id)。所有下行推送包 TaskScoped 信封。 */
  taskId: string;
  target: BridgeTarget;
  session: RemoteSession;
  /** 订阅/聚焦时生成回放条目。 */
  replay: () => Promise<TimelineItem[]>;
  /** 会话列表被本任务的 RPC 改动(archive/rename/delete)后通知 TaskManager 重推 tasks。 */
  onSessionsMutated?: () => void | Promise<void>;
  /** 连接态变化(含内部错误触发的 lost)通知 TaskManager 同步任务状态。 */
  onConnectionChange?: (state: ConnectionState) => void;
}

export interface Bridge {
  setConnection(state: ConnectionState): void;
  /** 聚焦本任务时主动重推回放。 */
  pushReplay(): Promise<void>;
  /**
   * 事件转发开关(后台任务抑制):关闭时事件不过 IPC,但仍进「当前轮缓冲」;
   * 重新打开前调用 replayBuffered() 把这一轮已发生的补齐。state 推送不受
   * 影响——任务行的 isRunning/角标要一直准。
   */
  setForwarding(on: boolean): void;
  /** 把当前轮缓冲的事件一次性推给 renderer(聚焦切换的补齐帧)。 */
  replayBuffered(): void;
  /** renderer 订阅(幂等)的 per-task 部分:重发回放/挂起审批/连接态/快照。 */
  subscribe(): Promise<{
    state: StateSnapshot;
    replayItems: TimelineItem[];
    connection: ConnectionState;
  }>;
  /** RPC 白名单(显式方法表,不做字符串透传)。 */
  dispatchRpc(request: RpcRequest): Promise<unknown>;
  /** 当前挂起的审批请求(TaskSummary.hasPendingPermission 的数据源)。 */
  pendingPermissionRequest(): PermissionRequest | undefined;
  /** 当前连接态(TaskManager 组装 subscribe 的 live 条目用)。 */
  connectionState(): ConnectionState;
  dispose(): void;
}

export function createBridge(deps: BridgeDeps): Bridge {
  const { target, session, taskId } = deps;
  let disposed = false;
  let currentConnection: ConnectionState = 'connecting';

  /** 所有下行推送包 TaskScoped 信封,renderer 侧按 taskId 分桶。 */
  const send = (channel: string, data: unknown): void => {
    target.send(channel, { taskId, data });
  };

  // ---- 下行:事件批量 ----
  let pendingEvents: AgentEvent[] = [];
  let eventFlushScheduled = false;
  /** 失焦任务不把事件推过 IPC(N 个后台任务的 text-delta 风暴不进 renderer)。 */
  let forwarding = true;
  /**
   * 当前轮的事件缓冲:turn-start 清空、turn-end/aborted 清空,期间攒着。
   * 聚焦切回一个正在跑的任务时按序重放,进行中那轮的流式内容才完整——
   * 有界(单轮 + 双封顶),不是全量时间线。
   */
  const BUFFER_MAX_EVENTS = 500;
  const BUFFER_MAX_BYTES = 2 * 1024 * 1024;
  let turnBuffer: AgentEvent[] = [];
  let turnBufferBytes = 0;
  let turnBufferTruncated = false;

  const resetTurnBuffer = (): void => {
    turnBuffer = [];
    turnBufferBytes = 0;
    turnBufferTruncated = false;
  };

  const bufferEvent = (event: AgentEvent): void => {
    if (event.type === 'turn-start') resetTurnBuffer();
    if (turnBufferTruncated) return;
    // 流式增量不进缓冲的原因不成立:补齐这一轮的正文正是它的目的。
    const size = JSON.stringify(serializeEvent(event))?.length ?? 0;
    if (turnBuffer.length >= BUFFER_MAX_EVENTS || turnBufferBytes + size > BUFFER_MAX_BYTES) {
      turnBufferTruncated = true;
      return;
    }
    turnBuffer.push(event);
    turnBufferBytes += size;
    if (event.type === 'turn-end' || event.type === 'aborted') resetTurnBuffer();
  };

  const scheduleEventFlush = (): void => {
    if (eventFlushScheduled) return;
    eventFlushScheduled = true;
    queueMicrotask(() => {
      eventFlushScheduled = false;
      if (disposed || pendingEvents.length === 0) return;
      if (!forwarding) {
        pendingEvents = []; // 后台:丢弃转发,内容已在 turnBuffer 里
        return;
      }
      send(IPC_CHANNELS.event, pendingEvents.map(serializeEvent));
      pendingEvents = [];
    });
  };

  // ---- 下行:状态推送(合并 + 去重) ----
  let lastStateKey = '';
  let statePushScheduled = false;
  const scheduleStatePush = (): void => {
    if (statePushScheduled) return;
    statePushScheduled = true;
    queueMicrotask(() => {
      statePushScheduled = false;
      if (disposed) return;
      const snapshot = session.snapshot;
      const key = snapshotKey(snapshot);
      if (key === lastStateKey) return;
      lastStateKey = key;
      send(IPC_CHANNELS.state, snapshot);
    });
  };

  // ---- 待决权限:asker 的 resolver 挂起,等 renderer 决策 ----
  let pendingPermission:
    | { request: PermissionRequest; resolve: (decision: PermissionDecision) => void }
    | undefined;

  const setConnection = (state: ConnectionState): void => {
    currentConnection = state;
    if (!disposed) send(IPC_CHANNELS.connection, state);
    deps.onConnectionChange?.(state);
  };

  const offBus = session.bus.on((event) => {
    bufferEvent(event);
    pendingEvents.push(event);
    scheduleEventFlush();
    scheduleStatePush();
    if (event.type === 'error' && !event.recoverable) setConnection('lost');
  });
  const offTodos = session.todos.subscribe(() => scheduleStatePush());
  const offSkills = session.skillsChanged(() => scheduleStatePush());
  // SSE 的 state 帧不产生 bus 事件(saveProvider/switch/别的客户端的操作),
  // 不订阅镜像自身的更新,这些"纯状态"变更要等下一个 agent 事件才被转发。
  const offState = session.stateChanged(() => scheduleStatePush());

  // asker 要尽早注册:remote 的 askerQueue 会把注册前到达的请求补发过来,
  // 不注册的话 server 侧 gate 会一直 await(--attach 半路接上时整轮挂死)。
  session.gate.setAsker((request) => {
    send(IPC_CHANNELS.permission, request);
    return new Promise((resolve) => {
      pendingPermission = { request, resolve };
    });
  });

  // 建桥即同步一次状态:空闲会话不产生任何 bus 事件,不主动推的话 renderer
  // 会一直停在「没有 snapshot」的空态(侧栏/Composer/设置页全部降级)。
  scheduleStatePush();

  const pushReplay = async (): Promise<void> => {
    const items = await deps.replay();
    if (!disposed) send(IPC_CHANNELS.replay, items);
  };

  // ---- 上行:订阅的 per-task 部分(幂等——renderer 重载/HMR 后重订阅) ----
  // 任务列表(tasks 通道)归 TaskManager,这里只管本任务的回放/审批/连接/快照。
  const subscribe = async (): Promise<{
    state: StateSnapshot;
    replayItems: TimelineItem[];
    connection: ConnectionState;
  }> => {
    const replayItems = await deps.replay();
    if (disposed) throw new Error('bridge 已关闭');
    send(IPC_CHANNELS.replay, replayItems);
    if (pendingPermission) send(IPC_CHANNELS.permission, pendingPermission.request);
    send(IPC_CHANNELS.connection, currentConnection);
    scheduleStatePush(); // lastStateKey 初值为空串,首次订阅必发一次。
    return { state: session.snapshot, replayItems, connection: currentConnection };
  };

  // ---- 上行:RPC 白名单(显式方法表,不做字符串透传) ----
  // 换会话三连(newSession/resumeSession/forkSession)已退役:一个 sidecar
  // 终生绑定一个会话,新任务/打开历史/fork 走 TaskManager 的 task:* 通道。
  // 各 case 的返回类型契约在 shared/ipc.ts 的 RpcResultMap——switch 做不了
  // kind 关联收窄,这里保持 Promise<unknown>,改返回值必须同步那张映射表。
  const dispatchRpc = async (request: RpcRequest): Promise<unknown> => {
    switch (request.kind) {
      case 'run':
        return session.agent.run(request.text, request.options);
      case 'abort':
        return session.agent.abort();
      case 'compact':
        return session.agent.compact();
      case 'switch':
        return session.switch(request.change);
      case 'saveProvider':
        return session.saveProvider(request.id, request.config);
      case 'deleteProvider':
        return session.deleteProvider(request.id);
      case 'setPermissions':
        return session.setPermissions(request.permissions);
      case 'setPlan':
        return session.setPlan(request.active);
      case 'setReasoningEffort':
        return session.setReasoningEffort(request.level);
      case 'listProviderModels':
        return session.listProviderModels();
      case 'testModel':
        return session.testModel(request.id, request.model);
      case 'modelCapabilities':
        return session.modelCapabilities(request.id, request.model);
      case 'runSkill':
        // deferred:一整轮 agent.run。调用方 fire-and-forget + catch,与 run 同构。
        return session.runSkill(
          request.name,
          request.args,
          request.display !== undefined ? { display: request.display } : undefined,
        );
      case 'startReview':
        return session.startReview(request.scope);
      case 'startSimplify':
        return session.startSimplify(request.target);
      case 'workspaceStatus':
        return session.workspaceStatus();
      case 'fileDiff':
        return session.fileDiff(request.path);
      case 'archiveSession': {
        const meta = await session.archiveSession(request.id, request.archived);
        await deps.onSessionsMutated?.(); // 任务列表即时刷新(TaskManager 重推 tasks)
        return meta;
      }
      case 'renameSession': {
        const meta = await session.renameSession(request.id, request.title);
        await deps.onSessionsMutated?.();
        return meta;
      }
      case 'deleteSession':
        await session.deleteSession(request.id);
        await deps.onSessionsMutated?.();
        return undefined;
      case 'listFiles':
        return session.listFiles();
      case 'readFile':
        return session.readFile(request.path);
      case 'switchBranch':
        return session.switchBranch(request.name);
      case 'commitAll':
        return session.commitAll(request.message);
      case 'undoCommit':
        return session.undoCommit();
      case 'discardAll':
        return session.discardAll();
      case 'reviewTargets':
        return session.reviewTargets();
      case 'permission': {
        if (!pendingPermission || pendingPermission.request.id !== request.id) return false;
        const entry = pendingPermission;
        pendingPermission = undefined;
        entry.resolve(request.decision);
        return true;
      }
      default:
        // wire 载荷不受信(renderer 可能被劫持),防御联合之外的未知 kind。
        throw new Error(`未实现的 RPC:${(request as { kind: string }).kind}`);
    }
  };

  return {
    setConnection,
    pushReplay,
    subscribe,
    dispatchRpc,
    setForwarding: (on: boolean) => {
      forwarding = on;
      if (!on) pendingEvents = [];
    },
    replayBuffered: () => {
      if (disposed || turnBuffer.length === 0) return;
      send(IPC_CHANNELS.event, turnBuffer.map(serializeEvent));
      if (turnBufferTruncated) {
        // 与 SSE gap 同一语义:如实说明这一轮的补齐不完整。
        send(IPC_CHANNELS.event, [
          serializeEvent({
            type: 'notice',
            level: 'warn',
            message: '本轮进行中的部分内容过多,已省略前半段',
          }),
        ]);
      }
    },
    pendingPermissionRequest: () => pendingPermission?.request,
    connectionState: () => currentConnection,
    dispose: () => {
      disposed = true;
      offBus();
      offTodos();
      offSkills();
      offState();
      // attach 模式下 server 不随 GUI 退出:挂起的审批必须收尾,否则 server
      // 侧 gate 永远等不到决定。
      pendingPermission?.resolve({ type: 'deny', reason: 'client closed' });
      pendingPermission = undefined;
      pendingEvents = [];
    },
  };
}
