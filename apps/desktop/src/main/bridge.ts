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

import type { AgentEvent, PermissionDecision } from '@core/events';
import type { RemoteSession } from '@core/remote';
import { serializeEvent, snapshotKey } from '@core/protocol';
import type { TimelineItem } from '@core/types';
import { IPC_CHANNELS } from '../shared/ipc.js';
import type { ConnectionState, RpcRequest, SubscribeResult } from '../shared/ipc.js';

/** BrowserWindow.webContents 的最小形状。 */
export interface BridgeTarget {
  send(channel: string, ...args: unknown[]): void;
}

export interface BridgeDeps {
  target: BridgeTarget;
  session: RemoteSession;
  /** 订阅/换会话时生成回放条目(M2 接 replayTimeline)。 */
  replay: () => Promise<TimelineItem[]>;
}

export interface Bridge {
  setConnection(state: ConnectionState): void;
  /** 换会话(newSession/resume/fork)后主动重推回放。 */
  pushReplay(): Promise<void>;
  /** renderer 订阅(幂等):重发快照/回放/连接态/挂起审批。 */
  subscribe(): Promise<SubscribeResult>;
  /** RPC 白名单(显式方法表,不做字符串透传)。 */
  dispatchRpc(request: RpcRequest): Promise<unknown>;
  dispose(): void;
}

export function createBridge(deps: BridgeDeps): Bridge {
  const { target, session } = deps;
  let disposed = false;
  let currentConnection: ConnectionState = 'connecting';

  // ---- 下行:事件批量 ----
  let pendingEvents: AgentEvent[] = [];
  let eventFlushScheduled = false;
  const scheduleEventFlush = (): void => {
    if (eventFlushScheduled) return;
    eventFlushScheduled = true;
    queueMicrotask(() => {
      eventFlushScheduled = false;
      if (disposed || pendingEvents.length === 0) return;
      target.send(IPC_CHANNELS.event, pendingEvents.map(serializeEvent));
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
      target.send(IPC_CHANNELS.state, snapshot);
    });
  };

  // ---- 待决权限:asker 的 resolver 挂起,等 renderer 决策 ----
  let pendingPermission:
    | { request: { id: string }; resolve: (decision: PermissionDecision) => void }
    | undefined;

  const setConnection = (state: ConnectionState): void => {
    currentConnection = state;
    if (!disposed) target.send(IPC_CHANNELS.connection, state);
  };

  const offBus = session.bus.on((event) => {
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
    target.send(IPC_CHANNELS.permission, request);
    return new Promise((resolve) => {
      pendingPermission = { request, resolve };
    });
  });

  const pushReplay = async (): Promise<void> => {
    const items = await deps.replay();
    if (!disposed) target.send(IPC_CHANNELS.replay, items);
  };

  /** 拉会话列表并下发;旧 server(unknown method)以 undefined 下发(侧栏降级)。
   * 跨工作区(all):侧栏按项目分组,其他项目的任务也要能列出来。 */
  const pushSessions = async (): Promise<void> => {
    try {
      const sessions = await session.listSessions(true);
      if (!disposed) target.send(IPC_CHANNELS.sessions, sessions);
    } catch {
      if (!disposed) target.send(IPC_CHANNELS.sessions, undefined);
    }
  };

  // ---- 上行:订阅(幂等——renderer 重载/HMR 后重订阅,重发快照与回放) ----
  const subscribe = async (): Promise<SubscribeResult> => {
    const replayItems = await deps.replay();
    if (disposed) throw new Error('bridge 已关闭');
    target.send(IPC_CHANNELS.replay, replayItems);
    if (pendingPermission) target.send(IPC_CHANNELS.permission, pendingPermission.request);
    target.send(IPC_CHANNELS.connection, currentConnection);
    scheduleStatePush(); // lastStateKey 初值为空串,首次订阅必发一次。
    void pushSessions(); // 异步补发,不挡 subscribe 的返回。
    return { state: session.snapshot, replayItems, connection: currentConnection };
  };

  /**
   * 换会话三连(new/resume/fork)的收尾:会话列表已过期要重拉,时间线要按
   * 新会话的 displayMessages 重放。调用方拿到 RPC 结果前完成这两步,侧栏
   * 与时间线不会闪一帧旧数据。
   */
  const afterSessionSwitch = async (): Promise<void> => {
    await Promise.all([pushSessions(), pushReplay()]);
  };

  // ---- 上行:RPC 白名单(显式方法表,不做字符串透传) ----
  const dispatchRpc = async (request: RpcRequest): Promise<unknown> => {
    switch (request.kind) {
      case 'run':
        return session.agent.run(request.text, request.options);
      case 'inject':
        return session.agent.inject(request.text, request.images);
      case 'abort':
        return session.agent.abort();
      case 'compact':
        return session.agent.compact();
      case 'newSession': {
        const result = await session.newSession();
        await afterSessionSwitch();
        return result;
      }
      case 'resumeSession': {
        const result = await session.resumeSession(request.idOrPrefix);
        await afterSessionSwitch();
        return result;
      }
      case 'forkSession': {
        const result = await session.forkSession();
        await afterSessionSwitch();
        return result;
      }
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
      case 'listSessions':
        return session.listSessions(true);
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
      case 'permission': {
        if (!pendingPermission || pendingPermission.request.id !== request.id) return false;
        const entry = pendingPermission;
        pendingPermission = undefined;
        entry.resolve(request.decision);
        return true;
      }
      default:
        // 契约里已声明、server/client 尚未实现的方法(如 M4 的 listSessions)。
        throw new Error(`未实现的 RPC:${(request as { kind: string }).kind}`);
    }
  };

  return {
    setConnection,
    pushReplay,
    subscribe,
    dispatchRpc,
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
