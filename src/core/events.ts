/**
 * agent 核心与其渲染层之间的契约。
 *
 * 核心从不引入 UI 框架(SolidJS)。它发出这些事件,因此同一个循环既驱动 TUI,
 * 也驱动非交互式的 `-p` 模式。
 */

import type { UiRequest } from './extension-types.js';

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /**
   * 本轮命中前缀缓存的输入 token。它是 inputTokens 的子集,两者之比即缓存
   * 命中率。可选:provider 不报缓存明细时保持缺省(与实测的 0% 区分),
   * 消费端也要容忍缺省(旧序列化事件)。
   */
  cachedInputTokens?: number;
  /** 整个会话的累计总量,而不只是本轮。 */
  cumulativeTotalTokens: number;
  contextWindow: number;
}

/**
 * 上下文占用的即时读数(计量条显示用):used 优先取 provider 上报的上一步
 * 输入 token,换史/清史/压缩后没有上报数时回落到本地估算,直到下一个
 * step-end 带回真实值。
 */
export interface ContextUsage {
  used: number;
  window: number;
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
  /**
   * 工具运行中的增量输出(目前只有 bash 发)。工具侧节流聚合后发射,
   * 单次调用总量封顶——尾部由 tool-end 的全量 output 兜底,消费端的推荐
   * 用法是 tool-end 到达时用全量替换积累的 delta。serve 侧按 transient 帧
   * 广播(不占序号、不进重放缓冲),TUI/headless 的 switch 落空即兼容。
   */
  | { type: 'tool-output-delta'; callId: string; chunk: string }
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
  // 压缩摘要的流式进度:chars=0 表示摘要请求刚发出(首个增量到达前),之后为
  // 已生成的累计字符数。正常以 compaction 事件收尾;失败时没有终止事件,
  // 渲染层靠错误 notice 与后续流事件自愈(见 App 的 compaction-progress 分支)。
  | { type: 'compaction-progress'; chars: number }
  | { type: 'compaction'; removedMessages: number; summaryChars: number }
  | { type: 'turn-end'; usage: UsageSnapshot; finishReason: string }
  /**
   * 一次 run() 的整个链条结束(首轮 + 扩展经 followUp 排进来的每一轮),
   * 无论结局。渲染层的"空闲"以它为准而不是 turn-end:两轮之间扩展可能正在
   * 评估、排下一轮,agent 仍是 isRunning——按 turn-end 熄灯会每两轮闪一次
   * "已空闲",像卡住了。
   */
  | { type: 'run-end' }
  | { type: 'aborted' }
  | { type: 'error'; error: Error; recoverable: boolean }
  | { type: 'notice'; level: 'info' | 'warn'; message: string }
  /**
   * 扩展向用户提问(见 extension-types.ts 的 UiRequest):前端弹提示框,答案
   * 经 `answerUi` 送回;`ui-resolved` 表示已有答案(别的客户端答的、或超时/
   * 取消),所有前端据此关掉同一 id 的提示框。
   */
  | { type: 'ui-request'; request: UiRequest }
  | { type: 'ui-resolved'; id: string }
  /**
   * 会话换了(`/new`、`/resume`、`/fork`,或扩展经 ctx.newSession / fork /
   * switchSession):渲染层据此重建时间线——命令路径自己也会重建,重复
   * 一次是幂等的;扩展路径只有这条通知。
   */
  | { type: 'session-changed'; reason: 'new' | 'resume' | 'fork'; id: string }
  /**
   * 扩展经 sendMessage 放进对话的一条自定义消息(不开轮或运行中注入的那两
   * 条路;开轮的那条路由 turn-start 的 userText 带着自定义信封)。渲染层按
   * customType 找扩展注册的画法。
   */
  | { type: 'custom-message'; customType: string; content: string; display?: string };

export type AgentEventHandler = (event: AgentEvent) => void;

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
