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
import type { ViewedTasksStore } from './gui-prefs.js';
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
  /** 退订本任务镜像的 stateChanged(dispose 时调用)。 */
  offState: () => void;
  /**
   * 首问乐观标记:run 类 RPC 一经分发就确定「有内容」。真实一轮里
   * turn-start 发出时快照还没变(isRunning 未置位、消息未进 history),
   * 第一个带出 historyLength 的 state 帧要等 step-end——不乐观置位的话,
   * 整个首答期间侧栏都不会出现任务行。title 同理:磁盘 meta 的标题在
   * 首次持久化之后才有。
   */
  optimistic?: { title: string };
}

/** 会开启一轮对话的 RPC(与 protocol 的 RUN_LIKE_METHODS 对应的 GUI 子集)。 */
const RUN_RPC_KINDS = new Set(['run', 'runSkill', 'startReview', 'startSimplify']);

/** 首问的乐观行标题(磁盘 meta 生成标题前的占位,取自用户输入)。 */
function optimisticTitle(request: RpcRequest): string {
  switch (request.kind) {
    case 'run':
      return (request.options?.display ?? request.text).trim().slice(0, 80);
    case 'runSkill':
      return request.display ?? `/${request.name}`;
    case 'startReview':
      return '/review';
    case 'startSimplify':
      return '/simplify';
    default:
      return '';
  }
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
  /**
   * 「已看状态」持久化(gui.json;缺省仅内存——测试与 attach 场景)。
   * 语义归 TaskManager:聚焦行持续记为已看,后台推进的行 unseen=true。
   */
  viewed?: ViewedTasksStore;
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

  // 已看表(会话 id → 用户最后看过的消息数,与会话 1:1):启动读盘,变更即
  // 落盘(GuiPrefs 内部去抖 + 原子写)。唯一写入方是本管理器——renderer 不
  // 持有任何 viewed 状态,行的 unseen 随 tasks 通道全量下发。
  const viewedCounts: Record<string, number> = deps.viewed?.load() ?? {};
  const markSeen = (id: string, count: number): void => {
    if (viewedCounts[id] === count) return;
    viewedCounts[id] = count;
    deps.viewed?.save(viewedCounts);
  };

  /** preloaded:调用方刚 listSessions() 过时传入,省一次全目录磁盘列举。 */
  const taskSummaries = async (
    preloaded?: TaskSummaryMeta[],
  ): Promise<TaskSummary[] | undefined> => {
    let metas: TaskSummaryMeta[];
    try {
      metas = preloaded ?? (await listSessions());
    } catch {
      return undefined;
    }
    // 已看表随会话删除而清理(否则表只增不减)。O(1) 闸门:已看表只收录
    // 存在过的会话,条目数超过会话数才可能有幽灵,才值得扫一遍。
    if (Object.keys(viewedCounts).length > metas.length) {
      const known = new Set(metas.map((meta) => meta.id));
      for (const id of Object.keys(viewedCounts)) {
        if (!known.has(id)) delete viewedCounts[id];
      }
      deps.viewed?.save(viewedCounts);
    }
    return metas.map((meta) => {
      const managed = tasks.get(meta.id);
      // 活跃任务的行数据不等磁盘 meta(持久化 + list() 有滞后):messageCount
      // 用镜像 historyLength 与首问乐观标记兜底,title 在 meta 生成标题前用
      // 乐观标题占位,isRunning 读含乐观标志的 getter(与 Composer 同语义,
      // run RPC 发出即为真,不等第一个 state 帧)。
      const messageCount = Math.max(
        meta.messageCount,
        managed?.desktop.session.snapshot.agent.historyLength ?? 0,
        managed?.optimistic ? 1 : 0,
      );
      const isRunning = managed?.desktop.session.agent.isRunning ?? false;
      // 聚焦中的行用户正看着:状态每推进一步都记为已看——切走后已看数停在
      // 离开时的值,后台再跑完一轮消息数就对不上,unseen 重新亮起。
      if (meta.id === focusedTaskId) markSeen(meta.id, messageCount);
      return {
        ...meta,
        messageCount,
        title: meta.title || managed?.optimistic?.title || '',
        status: managed?.status ?? 'dormant',
        isRunning,
        hasPendingPermission: managed?.bridge.pendingPermissionRequest() !== undefined,
        ...(managed ? { lastActivityAt: managed.lastActivityAt } : {}),
        // 运行中恒 false(行上是旋转图标);空会话没有可看的内容。
        unseen: !isRunning && messageCount > 0 && viewedCounts[meta.id] !== messageCount,
      };
    });
  };

  const pushTasks = async (preloaded?: TaskSummaryMeta[]): Promise<void> => {
    const summaries = await taskSummaries(preloaded);
    if (!disposed) target.send(IPC_CHANNELS.tasks, summaries);
  };

  const disposeTask = async (task: ManagedTask): Promise<void> => {
    task.offState();
    task.bridge.dispose();
    await task.desktop.dispose();
  };

  /** 容量把关:满员时淘汰「非聚焦、非运行、最久未动」的任务;全在忙则拒绝。 */
  const ensureCapacity = async (): Promise<void> => {
    if (tasks.size < maxActive) return;
    const candidates = [...tasks.values()]
      .filter((task) => task.taskId !== focusedTaskId)
      // 含乐观标志的 getter:run RPC 刚发出、state 帧未到的任务同样不可淘汰。
      .filter((task) => !task.desktop.session.agent.isRunning)
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
      offState: () => {}, // 建桥后立即换成真订阅
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
    // 行数据随镜像走:isRunning 翻转、首条消息落地(historyLength 0→N)时
    // 重推任务列表——空会话不再显示行之后,「行的出现」就靠这里(磁盘 meta
    // 的 messageCount 有持久化滞后,taskSummaries 已用镜像兜底)。按行关心
    // 的字段去重,其余 state 变更(config/todos)不触发磁盘 list()。
    let lastRowKey = '';
    task.offState = desktop.session.stateChanged(() => {
      const agent = desktop.session.snapshot.agent;
      const rowKey = `${agent.isRunning}|${agent.historyLength > 0}`;
      if (rowKey === lastRowKey) return;
      lastRowKey = rowKey;
      void pushTasks();
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
    void pushTasks(); // 聚焦即记为已看,行上的未读点立刻熄灭
  };

  const openTask = async (sessionId: string): Promise<string> => {
    if (tasks.has(sessionId)) {
      await focusTask(sessionId);
      return sessionId;
    }
    const metas = await listSessions();
    const meta = metas.find((m) => m.id === sessionId);
    if (!meta) throw new Error(`找不到会话 ${sessionId}`);
    // 点开即算看过:sidecar 复活要几秒,未读点不该等 spawn 完成才熄灭。
    // 复用刚列举的 metas(免二次磁盘枚举),且 await 住——否则这条推送与
    // createTask 尾部的推送并发,晚到的旧快照会盖掉带新任务行的那条。
    markSeen(sessionId, meta.messageCount);
    await pushTasks(metas);
    return createTask({ root: meta.root, resume: sessionId });
  };

  const dispatchRpc = async (request: RpcRequest, taskId?: string): Promise<unknown> => {
    const task = taskId ? tasks.get(taskId) : focusedTaskId ? tasks.get(focusedTaskId) : undefined;
    if (!task) throw new Error('没有可用的活跃任务');
    task.lastActivityAt = Date.now();
    // 首问即出现(Codex 形态):run 一经分发就乐观置位并立即重推任务行,
    // 不等镜像的 state 帧(它最早在 step-end 才带出 historyLength)。先分发
    // 再推:RemoteSession 在发出 POST 前同步置 optimistic.run,推送才能带上
    // isRunning=true 的行。
    const result = task.bridge.dispatchRpc(request);
    if (!task.optimistic && RUN_RPC_KINDS.has(request.kind)) {
      task.optimistic = { title: optimisticTitle(request) };
      void pushTasks();
    }
    return result;
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
      if (task.desktop.session.agent.isRunning) continue;
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
