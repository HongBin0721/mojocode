/**
 * The contract between the agent core and whatever is rendering it.
 *
 * The core never imports React. It emits these events and awaits permission
 * decisions through a callback, so the exact same loop drives the Ink TUI and
 * the non-interactive `-p` mode.
 */

export type PermissionDecision =
  | { type: 'allow' }
  /** Allow, and remember this pattern for the rest of the session. */
  | { type: 'allow-always'; rule: string }
  /** Allow, and persist the rule into <workspace>/.kdg/config.json. */
  | { type: 'allow-persist'; rule: string }
  | { type: 'deny'; reason?: string };

export interface PermissionRequest {
  id: string;
  toolName: string;
  /** One-line summary, e.g. `bash: npm test` or `write: src/index.ts`. */
  title: string;
  /** Optional detail body — a diff preview, the full command, etc. */
  detail?: string;
  /** The rule that `allow-always` would add, e.g. `Bash(npm test:*)`. */
  suggestedRule?: string;
  risk: 'read' | 'write' | 'execute';
}

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Running total across the whole session, not just this turn. */
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
      /** Short line for the collapsed view, e.g. `Read 120 lines`. */
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

/** Asks the host (TUI or headless policy) to approve a tool call. */
export type PermissionAsker = (request: PermissionRequest) => Promise<PermissionDecision>;

/** Minimal typed emitter — an EventEmitter would lose the discriminated union. */
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
        // A broken renderer must never take down the agent loop.
      }
    }
  }
}
