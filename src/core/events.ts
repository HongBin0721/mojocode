/**
 * agent 核心与其渲染层之间的契约。
 *
 * 核心从不引入 UI 框架(SolidJS)。它发出这些事件,并通过回调等待权限决定,因此同一个
 * 循环既驱动 TUI,也驱动非交互式的 `-p` 模式。
 */

import type { Permissions } from '../config/schema.js';

export type PermissionDecision =
  | { type: 'allow' }
  /** 允许,并在本会话余下时间里记住这个模式。 */
  | { type: 'allow-always'; rule: string }
  /** 允许,并把规则持久化到 <workspace>/.mojocode/config.json。 */
  | { type: 'allow-persist'; rule: string }
  | { type: 'deny'; reason?: string };

export interface PermissionRequest {
  id: string;
  toolName: string;
  /**
   * 请求的种类。`plan` 是计划模式下呈交实现方案等待批准——它不是"某个工具
   * 要不要放行",而是"这个方案对不对",所以标题、选项文案与正文渲染都不同
   * (详情是 markdown 计划正文,不是 diff)。缺省视为 `tool`。
   */
  kind?: 'tool' | 'plan';
  /** 一行摘要,例如 `bash: npm test` 或 `write: src/index.ts`。 */
  title: string;
  /** 可选的详情正文——diff 预览、完整命令等。 */
  detail?: string;
  /** `allow-always` 会添加的规则,例如 `Bash(npm test:*)`。 */
  suggestedRule?: string;
  /**
   * `network` 是联网工具(web_search/web_fetch)专用:它决定规则记进哪个桶
   * (allowNet)。刻意不复用从未启用的 `read`——网络是数据外传通道,不是只读,
   * 而且 read 的语义要留给将来真正的本地读确认。
   */
  risk: 'read' | 'write' | 'execute' | 'network';
}

/**
 * 目标循环(`/goal`)停下来的原因。任何一种都会解除目标——留着的话,用户
 * 中断之后随口发的下一条消息会把自动循环又悄悄点着,而那正是最该避免的意外。
 *
 * 核心只报事实,文案由渲染层按各自的语言映射(与 permission-change 同理)。
 */
export type GoalStopReason =
  /** 评估器判定条件已达成。 */
  | 'met'
  /** 用户 `/goal clear`,或 `/new`、`/resume` 换掉了会话。 */
  | 'cleared'
  /** 被新设定的目标取代。 */
  | 'replaced'
  /** 触及自动续跑的轮数上限。 */
  | 'max-turns'
  /** 这一轮被 esc 中断(没有 turn-end)。 */
  | 'aborted'
  /** 这一轮以错误收尾(同样没有 turn-end)。 */
  | 'error'
  /** 评估器连续给不出可解析的判词——不能靠猜继续烧 token。 */
  | 'check-failed'
  /** 进入了计划模式:它的要义是停下来等批准,与自动续跑正相反。 */
  | 'plan-mode';

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 整个会话的累计总量,而不只是本轮。 */
  cumulativeTotalTokens: number;
  contextWindow: number;
}

export type AgentEvent =
  // display:时间线展示用的替代文本(如 `/init`);userText 才是喂给模型的内容。
  | { type: 'turn-start'; userText: string; display?: string; imageCount?: number }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; text: string }
  | { type: 'text-end'; id: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; text: string }
  | { type: 'reasoning-end'; id: string }
  | { type: 'tool-start'; callId: string; toolName: string; input: unknown }
  | {
      type: 'tool-end';
      callId: string;
      toolName: string;
      /** 折叠视图中的简短一行,例如 `Read 120 lines`。 */
      summary: string;
      output: unknown;
      isError: boolean;
      durationMs: number;
    }
  | { type: 'permission-request'; request: PermissionRequest }
  | { type: 'permission-resolved'; id: string; decision: PermissionDecision }
  // 权限变化(两轴组合和/或 plan 标志)。`exit_plan` 批准后由工具侧切换,
  // 渲染层只能靠这条事件跟上——否则状态栏会一直停在 plan。
  | { type: 'permission-change'; permissions: Permissions; plan: boolean }
  // `/goal` 的自动续跑循环。核心只发事件,渲染层(TUI / headless)自己决定
  // 怎么呈现——GoalController 因此与渲染层互不相识。
  //
  // 目标已设定(`/goal <条件>`),或从会话记录中恢复(restored 为真时不自动开跑)。
  | { type: 'goal-start'; condition: string; restored: boolean }
  /** 一轮收尾后评估器开始判定。turn 是本目标已跑完的轮数。 */
  | { type: 'goal-evaluating'; turn: number }
  // 一次评估的结论。met 为假时 reason 会原样成为下一轮的指令,所以它既是
  // 给用户看的解释,也是给模型的指示。
  | { type: 'goal-verdict'; met: boolean; reason: string; turn: number; maxTurns: number }
  // 目标循环终止。统计随事件带出,渲染层不必自己记账。
  | {
      type: 'goal-stop';
      reason: GoalStopReason;
      condition: string;
      /** 评估器最后一次的判词;从未评估过时为空串。 */
      detail: string;
      turns: number;
      elapsedMs: number;
      /** 本次目标消耗的 token,含评估器自身的开销。 */
      tokens: number;
    }
  // 子 agent(task 工具)的进度。子 agent 在自己的 EventBus 上跑,细节事件
  // 不进主时间线——只把"跑到哪了"以这一条聚合事件转发出来,由渲染层贴在
  // 进行中的 Task 工具行上。callId 即那次 task 调用的 toolCallId。
  | {
      type: 'task-progress';
      callId: string;
      description: string;
      /** 子 agent 已完成的步数。 */
      steps: number;
      /** 子 agent 迄今消耗的 token(其累计值,最终由 tool 结果定稿)。 */
      tokens: number;
      /** 子 agent 当前正在跑的工具;两次工具之间为 undefined(思考中)。 */
      currentTool?: string;
      /**
       * 最近启动的几条工具调用(旧→新,最多 3 条),渲染层缩进画成过程轨迹。
       * 带原始 input 而不是格式化文本:core 不做 UI 格式化(那是 theme.ts 的
       * formatToolInput 的事),与主总线 tool-start 携带原始 input 同一约定。
       */
      recentCalls?: Array<{ toolName: string; input: unknown }>;
    }
  | { type: 'step-end'; usage: UsageSnapshot }
  | { type: 'compaction'; removedMessages: number; summaryChars: number }
  | { type: 'turn-end'; usage: UsageSnapshot; finishReason: string }
  | { type: 'aborted' }
  | { type: 'error'; error: Error; recoverable: boolean }
  | { type: 'notice'; level: 'info' | 'warn'; message: string };

export type AgentEventHandler = (event: AgentEvent) => void;

/** 请求宿主(TUI 或 headless 策略)批准一次工具调用。 */
export type PermissionAsker = (request: PermissionRequest) => Promise<PermissionDecision>;

/** 极简的类型化事件发射器——用 EventEmitter 会丢失可辨识联合类型。 */
export class EventBus {
  private handlers = new Set<AgentEventHandler>();

  on(handler: AgentEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: AgentEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // 渲染层出错绝不能拖垮 agent 循环。
      }
    }
  }
}
