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
  SessionMetaSummary,
  SubscribeResult,
  WireEvent,
} from './ipc.js';
import type { StateSnapshot } from '@core/protocol';
import type { PermissionRequest } from '@core/events';
import type { TimelineItem } from '@core/types';

export interface MojocodeDesktopApi {
  /** 订阅桥(幂等):返回初始快照 + 回放条目 + 连接状态。 */
  subscribe(): Promise<SubscribeResult>;
  /** 调用白名单方法。失败以 rejection 形式返回(message 过 IPC 保留)。 */
  rpc(request: RpcRequest): Promise<unknown>;
  /** 订阅下行通道,载荷类型按通道推导。返回退订函数。 */
  on<C extends PushChannel>(channel: C, listener: (payload: PushPayloads[C]) => void): () => void;
  /** 主进程平台('darwin' 等):侧栏红绿灯让位 / drag region 仅 mac 需要。 */
  readonly platform: string;
  /** 原生目录选择器(添加项目)。取消返回 undefined。 */
  pickDirectory(): Promise<string | undefined>;
  /**
   * 切换工作区:重启受管 sidecar 到新 root,随后 main 强推整套镜像
   * (state/replay/sessions)。attach 模式或当前有运行中的轮会 reject。
   */
  switchWorkspace(root: string): Promise<void>;
}

/** 各通道的载荷类型(on 的 listener 参数由此推导)。 */
export interface PushPayloads {
  state: StateSnapshot;
  event: WireEvent[];
  replay: TimelineItem[];
  connection: ConnectionState;
  permission: PermissionRequest;
  /** undefined = server 过旧(unknown method),侧栏降级提示。 */
  sessions: SessionMetaSummary[] | undefined;
}
