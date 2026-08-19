/**
 * preload 经 contextBridge 暴露给 renderer 的 API 形状(`window.mojocode`)。
 * 放在 shared 而非 preload 目录:renderer 要 import 它的类型,而 preload 的
 * 顶层 import 'electron' 不该被 renderer 构建看到(类型擦除无所谓,但源文件
 * 位置本身就是边界——shared 是两端契约的家)。
 */

import type {
  ConnectionState,
  PushChannel,
  RpcRequest,
  RpcResult,
  SubscribeResult,
  TaskScoped,
  TaskSummary,
  WireEvent,
} from './ipc.js';
import type { StateSnapshot } from '@core/protocol';
import type { PermissionRequest } from '@core/events';
import type { TimelineItem } from '@core/types';

export interface MojocodeDesktopApi {
  /** 订阅桥(幂等):返回任务列表 + 各活跃任务的即时状态(聚焦任务带回放)。 */
  subscribe(): Promise<SubscribeResult>;
  /**
   * 调用白名单方法。缺省路由到聚焦任务;带 taskId 时定向(后台任务的审批
   * 决策等)。失败以 rejection 形式返回(message 过 IPC 保留)。
   * 响应类型按请求 kind 从 RpcResultMap 推导(preload 的 ipcRenderer.invoke
   * 返回 Promise<any>,对这个泛型签名天然可赋值,实现零改动)。
   */
  rpc<R extends RpcRequest>(request: R, taskId?: string): Promise<RpcResult<R['kind']>>;
  /** 订阅下行通道,载荷类型按通道推导。返回退订函数。 */
  on<C extends PushChannel>(channel: C, listener: (payload: PushPayloads[C]) => void): () => void;
  /** 主进程平台('darwin' 等):侧栏红绿灯让位 / drag region 仅 mac 需要。 */
  readonly platform: string;
  /** 原生目录选择器(添加项目)。取消返回 undefined。 */
  pickDirectory(): Promise<string | undefined>;
  /** 新建任务(在指定 root 拉一个 sidecar;resume/fork 复活历史)。返回 taskId。 */
  createTask(opts: { root: string; resume?: string; fork?: boolean }): Promise<string>;
  /** 打开任务:活跃的直接聚焦,休眠的以 --resume 复活。返回 taskId。 */
  openTask(sessionId: string): Promise<string>;
  /** 关停任务的 sidecar(行保留,变 dormant)。 */
  closeTask(taskId: string): Promise<void>;
  /** 聚焦切换:main 重推该任务的回放。 */
  focusTask(taskId: string): Promise<void>;
  /** 在 Finder/资源管理器中显示(右键菜单「在 Finder 中显示」)。 */
  revealPath(path: string): Promise<void>;
  /** 用系统默认程序打开文件(diff 菜单「在编辑器中打开」)。 */
  openPath(path: string): Promise<void>;
  /** 拖入的 File 对象 → 磁盘绝对路径(导入项目对话框的拖放区;sandbox 下
   * renderer 拿不到 file.path,只能经 preload 的 webUtils)。 */
  pathForFile(file: File): string;
  /** GUI 本机偏好(主进程落盘 ~/.mojocode/gui.json,localStorage 形状的字符
   * 串键值):snapshot 是 preload 启动时同步取的一次性副本,set 走 fire-and-
   * forget——写后的最新值由 renderer 侧 host.ts 的内存缓存维护。 */
  prefs: {
    readonly snapshot: Record<string, string>;
    set(key: string, value: string): void;
  };
}

/** 各通道的载荷类型(on 的 listener 参数由此推导);per-task 通道包 TaskScoped 信封。 */
export interface PushPayloads {
  state: TaskScoped<StateSnapshot>;
  event: TaskScoped<WireEvent[]>;
  replay: TaskScoped<TimelineItem[]>;
  connection: TaskScoped<ConnectionState>;
  permission: TaskScoped<PermissionRequest>;
  /** undefined = 会话列表读取失败(降级提示)。 */
  tasks: TaskSummary[] | undefined;
}
