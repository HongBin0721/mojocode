/**
 * agent 核心与其渲染层之间的契约。
 *
 * 核心从不引入 React。它发出这些事件,并通过回调等待权限决定,因此同一个
 * 循环既驱动 Ink TUI,也驱动非交互式的 `-p` 模式。
 */

export type PermissionDecision =
  | { type: 'allow' }
  /** 允许,并在本会话余下时间里记住这个模式。 */
  | { type: 'allow-always'; rule: string }
  /** 允许,并把规则持久化到 <workspace>/.kdg/config.json。 */
  | { type: 'allow-persist'; rule: string }
  | { type: 'deny'; reason?: string };

export interface PermissionRequest {
  id: string;
  toolName: string;
  /** 一行摘要,例如 `bash: npm test` 或 `write: src/index.ts`。 */
  title: string;
  /** 可选的详情正文——diff 预览、完整命令等。 */
  detail?: string;
  /** `allow-always` 会添加的规则,例如 `Bash(npm test:*)`。 */
  suggestedRule?: string;
  risk: 'read' | 'write' | 'execute';
}

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 整个会话的累计总量,而不只是本轮。 */
  cumulativeTotalTokens: number;
  contextWindow: number;
}

export type AgentEvent =
  | { type: 'turn-start'; userText: string }
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
