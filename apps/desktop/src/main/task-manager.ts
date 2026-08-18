/**
 * 任务管理器:多 sidecar 编排(一个任务 = 一个会话 = 一个受管 serve 进程)。
 *
 * taskId 与 core 的 store id 1:1——任务列表本来就是「历史会话 ∪ 活跃 sidecar」,
 * 休眠任务(无进程)只有 sessionId 可用;bridge 在 connect 完成、拿到 storeId
 * 之后才创建,不存在 pending 期的 rebind。任务列表不依赖任何活着的 sidecar:
 * main 直接 `SessionStore.list()`(meta 旁车 O(1),原子写读侧安全)。
 *
 * electron-free(依赖注入 spawn/connect/listSessions),测试不起真进程。
 */

import { SessionStore } from '@core/session-store';
import { createBridge, type Bridge, type BridgeTarget } from './bridge.js';
import { buildReplayItems } from './replay.js';
import type { ServerRuntime } from './resolve-runtime.js';
import {
  startDesktopSession,
  type AttachOptions,
  type ConnectFn,
  type DesktopSession,
  type SpawnFn,
} from './session-service.js';
import { IPC_CHANNELS } from '../shared/ipc.js';
import type {
  ConnectionState,
  LiveTaskState,
  RpcRequest,
  SubscribeResult,
  TaskStatus,
  TaskSummary,
} from '../shared/ipc.js';

/** 同时活跃的 sidecar 上限(每个都有自己的 MCP/LSP,成本真实)。 */
const MAX_ACTIVE_SIDECARS = 4;
/** disposeAll 的总限时:一个卡死的 sidecar 不该拖住 Cmd+Q。 */
const DISPOSE_ALL_TIMEOUT_MS = 8_000;
/** 空闲回收:非聚焦、非运行、超过这个时长没动静的任务转 dormant。 */
const IDLE_SHUTDOWN_MS = 5 * 60_000;
const IDLE_SWEEP_MS = 60_000;

interface ManagedTask {
  taskId: string;
  root: string;
  desktop: DesktopSession;
  bridge: Bridge;
  status: TaskStatus;
  lastActivityAt: number;
}

export interface TaskManagerDeps {
  runtime: ServerRuntime;
  target: BridgeTarget;
  /** attach 模式:唯一任务连外部 server,createTask/openTask 被禁用。 */
  attach?: AttachOptions;
  maxActive?: number;
  spawnServer?: SpawnFn;
  connect?: ConnectFn;
  /** 全局会话列表(默认 SessionStore.list();测试注入假表)。 */
  listSessions?: () => Promise<Array<TaskSummaryMeta>>;
}

/** listSessions 依赖的最小 meta 形状(= SessionMeta 的 wire 子集)。 */
export interface TaskSummaryMeta {
  id: string;
  root: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  messageCount: number;
  archivedAt?: string;
}

export interface TaskManager {
  /** 新建任务(或以 resume/fork 复活历史会话)。返回正式 taskId(= storeId)。 */
  createTask(opts: { root: string; resume?: string; fork?: boolean }): Promise<string>;
  /** 打开任务:活跃的直接聚焦,休眠的以 `--resume` 复活。 */
  openTask(sessionId: string): Promise<string>;
  /** 关停任务的 sidecar(行保留,变 dormant)。 */
  closeTask(taskId: string): Promise<void>;
  /** 聚焦切换:重推该任务的回放。 */
  focusTask(taskId: string): Promise<void>;
  dispatchRpc(request: RpcRequest, taskId?: string): Promise<unknown>;
  subscribe(): Promise<SubscribeResult>;
  disposeAll(): Promise<void>;
  readonly focusedTaskId: string | undefined;
}

export function createTaskManager(deps: TaskManagerDeps): TaskManager {
  const { runtime, target } = deps;
  const maxActive = deps.maxActive ?? MAX_ACTIVE_SIDECARS;
  const listSessions =
    deps.listSessions ?? (() => SessionStore.list() as Promise<TaskSummaryMeta[]>);

  const tasks = new Map<string, ManagedTask>();
  let focusedTaskId: string | undefined;
  let disposed = false;

  const taskSummaries = async (): Promise<TaskSummary[] | undefined> => {
    let metas: TaskSummaryMeta[];
    try {
      metas = await listSessions();
    } catch {
      return undefined;
    }
    return metas.map((meta) => {
      const managed = tasks.get(meta.id);
      return {
        ...meta,
        status: managed?.status ?? 'dormant',
        isRunning: managed?.desktop.session.snapshot.agent.isRunning ?? false,
        hasPendingPermission: managed?.bridge.pendingPermissionRequest() !== undefined,
        ...(managed ? { lastActivityAt: managed.lastActivityAt } : {}),
      };
    });
  };

  const pushTasks = async (): Promise<void> => {
    const summaries = await taskSummaries();
    if (!disposed) target.send(IPC_CHANNELS.tasks, summaries);
  };

  const disposeTask = async (task: ManagedTask): Promise<void> => {
    task.bridge.dispose();
    await task.desktop.dispose();
  };

  /** 容量把关:满员时淘汰「非聚焦、非运行、最久未动」的任务;全在忙则拒绝。 */
  const ensureCapacity = async (): Promise<void> => {
    if (tasks.size < maxActive) return;
    const candidates = [...tasks.values()]
      .filter((task) => task.taskId !== focusedTaskId)
      .filter((task) => !task.desktop.session.snapshot.agent.isRunning)
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    const victim = candidates[0];
    if (!victim) {
      throw new Error('活跃任务已满且都在运行中,先停掉一个再新建');
    }
    tasks.delete(victim.taskId);
    await disposeTask(victim); // 绝不静默杀运行中的 agent(上面已过滤)
  };

  const createTask = async (opts: {
    root: string;
    resume?: string;
    fork?: boolean;
  }): Promise<string> => {
    if (disposed) throw new Error('任务管理器已关闭');
    if (deps.attach && tasks.size > 0) throw new Error('attach 模式不支持多任务');
    await ensureCapacity();

    const serveExtraArgs = [
      ...(opts.resume ? ['--resume', opts.resume] : []),
      ...(opts.fork ? ['--fork-session'] : []),
    ];
    const desktop = await startDesktopSession({
      root: opts.root,
      attach: deps.attach,
      runtime,
      serveExtraArgs,
      spawnServer: deps.spawnServer,
      connect: deps.connect,
    });

    const taskId = desktop.session.store.id;
    // 同一会话被重复打开(竞态双击):丢弃后来的 sidecar,复用已有任务。
    const existing = tasks.get(taskId);
    if (existing) {
      await desktop.dispose();
      focusedTaskId = taskId;
      return taskId;
    }

    const task: ManagedTask = {
      taskId,
      root: opts.root,
      desktop,
      bridge: undefined as unknown as Bridge, // 下一行立即赋值
      status: 'connected',
      lastActivityAt: Date.now(),
    };
    task.bridge = createBridge({
      taskId,
      target,
      session: desktop.session,
      replay: async () => buildReplayItems(desktop.session),
      onSessionsMutated: () => pushTasks(),
      onConnectionChange: (state: ConnectionState) => {
        task.status = state === 'lost' ? 'lost' : 'connected';
        void pushTasks();
      },
    });
    tasks.set(taskId, task);
    // 新任务即聚焦:旧的聚焦任务转后台(抑制事件转发)。
    const previous = focusedTaskId ? tasks.get(focusedTaskId) : undefined;
    if (previous && previous.taskId !== taskId) previous.bridge.setForwarding(false);
    focusedTaskId = taskId;
    task.bridge.setConnection('connected');
    await pushTasks();
    return taskId;
  };

  const closeTask = async (taskId: string): Promise<void> => {
    const task = tasks.get(taskId);
    if (!task) return;
    tasks.delete(taskId);
    if (focusedTaskId === taskId) focusedTaskId = undefined;
    await disposeTask(task);
    await pushTasks();
  };

  /**
   * 聚焦切换:先把旧任务转后台,再对新任务串行推送
   * replay(持久化历史)→ 当前轮缓冲(补齐进行中的流)→ 开转发。
   * 顺序是硬约束:renderer 按到达序 apply,replay 会重置时间线桶。
   */
  const focusTask = async (taskId: string): Promise<void> => {
    const task = tasks.get(taskId);
    if (!task) return; // 休眠任务的聚焦走 openTask(要先复活)
    const previous = focusedTaskId ? tasks.get(focusedTaskId) : undefined;
    if (previous && previous.taskId !== taskId) previous.bridge.setForwarding(false);
    focusedTaskId = taskId;
    task.lastActivityAt = Date.now();
    await task.bridge.pushReplay();
    task.bridge.replayBuffered();
    task.bridge.setForwarding(true);
  };

  const openTask = async (sessionId: string): Promise<string> => {
    if (tasks.has(sessionId)) {
      await focusTask(sessionId);
      return sessionId;
    }
    const metas = await listSessions();
    const meta = metas.find((m) => m.id === sessionId);
    if (!meta) throw new Error(`找不到会话 ${sessionId}`);
    return createTask({ root: meta.root, resume: sessionId });
  };

  const dispatchRpc = async (request: RpcRequest, taskId?: string): Promise<unknown> => {
    const task = taskId ? tasks.get(taskId) : focusedTaskId ? tasks.get(focusedTaskId) : undefined;
    if (!task) throw new Error('没有可用的活跃任务');
    task.lastActivityAt = Date.now();
    return task.bridge.dispatchRpc(request);
  };

  const subscribe = async (): Promise<SubscribeResult> => {
    const live: LiveTaskState[] = [];
    for (const task of tasks.values()) {
      if (task.taskId === focusedTaskId) {
        // 聚焦任务:完整重放(回放 + 挂起审批 + 连接态 + 快照推送)。
        const result = await task.bridge.subscribe();
        live.push({
          taskId: task.taskId,
          state: result.state,
          connection: result.connection,
          permission: task.bridge.pendingPermissionRequest(),
          replayItems: result.replayItems,
        });
      } else {
        live.push({
          taskId: task.taskId,
          state: task.desktop.session.snapshot,
          connection: task.bridge.connectionState(),
          permission: task.bridge.pendingPermissionRequest(),
        });
      }
    }
    void pushTasks(); // 异步补发,不挡 subscribe 的返回
    return { tasks: await taskSummaries(), focusedTaskId, live };
  };

  /** 空闲回收:非聚焦 + 非运行 + 超时未动 → 关 sidecar(行留在列表,dormant)。 */
  const sweepIdle = (): void => {
    const now = Date.now();
    for (const task of [...tasks.values()]) {
      if (task.taskId === focusedTaskId) continue;
      if (task.desktop.session.snapshot.agent.isRunning) continue;
      if (now - task.lastActivityAt < IDLE_SHUTDOWN_MS) continue;
      void closeTask(task.taskId).catch(() => {});
    }
  };
  const idleTimer = setInterval(sweepIdle, IDLE_SWEEP_MS);
  // Node 侧:定时器不该拖住进程退出。
  (idleTimer as unknown as { unref?: () => void }).unref?.();

  const disposeAll = async (): Promise<void> => {
    disposed = true;
    clearInterval(idleTimer);
    const all = [...tasks.values()];
    tasks.clear();
    await Promise.race([
      Promise.allSettled(all.map((task) => disposeTask(task))),
      new Promise((resolve) => setTimeout(resolve, DISPOSE_ALL_TIMEOUT_MS)),
    ]);
  };

  return {
    createTask,
    openTask,
    closeTask,
    focusTask,
    dispatchRpc,
    subscribe,
    disposeAll,
    get focusedTaskId() {
      return focusedTaskId;
    },
  };
}
