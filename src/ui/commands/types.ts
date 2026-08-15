import type { Setter } from 'solid-js';
import type { SessionHandle } from '../../app/session-handle.js';
import type { NewTimelineItem, TimelineItem } from '../types.js';
import type { UsageMirror } from '../timeline-controller.js';
import type { WorkState } from '../StatusLine.js';
import type { ProviderActions } from '../provider-actions.js';
import type { ProviderRow } from '../ProviderPicker.js';
import type { ReviewPickerRow } from '../ReviewPicker.js';
import type { ProviderModels } from '../../model/registry.js';
import type { Permissions, ReasoningEffort, TimelineMode } from '../../config/schema.js';
import type { SubmitGate } from './submit-gate.js';

/**
 * 命令处理器的依赖集合(原 App.tsx 的 runCommand 巨型 switch 拆散后的
 * 接线)。接口宽是诚实的代价:switch 的每个 case 本来就能摸到 App 闭包的
 * 一切。成员全部是函数或引用——没有解构求值,不引入 Solid 响应式丢失;
 * getter 一律现读信号,handler 里对它们的读取等价于原来对闭包变量的读取。
 */

export interface ReviewPickerState {
  kind: 'base' | 'commit';
  title: string;
  rows: ReviewPickerRow[];
}

export interface CommandContext {
  session: SessionHandle;
  /** 退出 TUI(useApp().exit)。 */
  exit: () => void;
  push: (item: NewTimelineItem) => void;
  // ---- timeline-controller 的读写对 ----
  setItems: Setter<TimelineItem[]>;
  setUsage: Setter<UsageMirror>;
  setWork: Setter<WorkState | undefined>;
  endWork: () => void;
  usage: () => UsageMirror;
  // ---- App 的镜像信号(getter 现读,setter 直写) ----
  perms: () => Permissions;
  planActive: () => boolean;
  modeLabel: () => string;
  think: () => ReasoningEffort;
  timelineMode: () => TimelineMode;
  setPerms: (p: Permissions) => void;
  setPlanActive: (v: boolean) => void;
  setThink: (v: ReasoningEffort) => void;
  setTimelineMode: (m: TimelineMode) => void;
  setProviderLabel: (v: string) => void;
  setModel: (v: string) => void;
  setRunning: (v: boolean) => void;
  // ---- 覆盖层开关 ----
  setSettingsOpen: (v: boolean) => void;
  setModelsPicker: (v: ProviderModels[] | undefined) => void;
  setProviderPicker: (v: ProviderRow[] | undefined) => void;
  setReviewPicker: (v: ReviewPickerState | undefined) => void;
  setPrefill: (v: { text: string } | undefined) => void;
  // ---- 共享动作 ----
  /** 运行中拦截谓词(isRunning || isCompacting || 提交在途 || goal.busy)。 */
  busy: () => boolean;
  /** 读 state 镜像的横幅(区别于 sessionBanner 读 session 值)。 */
  bannerItem: () => TimelineItem;
  /** 把两轴档位写进本工作区配置(approvals 与 App 的 applyMode 共用一条落盘路径)。 */
  persistPermissions: (next: Permissions) => Promise<string | undefined>;
  providerActions: ProviderActions;
  submitGate: SubmitGate;
}

/** 一个命令分支:入参是去掉斜杠与命令名后的剩余文本。 */
export type CommandHandler = (ctx: CommandContext, arg: string) => Promise<void> | void;
