import type { PermissionGate } from '../permissions/gate.js';
import type { EventBus } from '../core/events.js';
import type { PermissionRules } from '../config/schema.js';

/** Shared state every built-in tool needs. Passed by closure, not by AI SDK context. */
export interface ToolContext {
  root: string;
  gate: PermissionGate;
  bus: EventBus;
  rules: PermissionRules;
  /** Files the agent has read this session — `edit` refuses to touch unread files. */
  readFiles: Set<string>;
}

/** Guards against blowing the context window on one huge tool result. */
export const MAX_OUTPUT_CHARS = 30_000;

export function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const kept = text.slice(0, limit);
  return `${kept}\n\n… output truncated (${text.length - limit} more characters)`;
}
