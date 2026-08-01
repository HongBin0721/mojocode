import type { PermissionGate } from '../permissions/gate.js';
import type { EventBus } from '../core/events.js';
import type { PermissionRules } from '../config/schema.js';

/** 所有内置工具共享的状态。通过闭包传递,而非 AI SDK 的 context。 */
export interface ToolContext {
  root: string;
  gate: PermissionGate;
  bus: EventBus;
  rules: PermissionRules;
  /** 本会话中 agent 已读取过的文件——`edit` 拒绝修改未读过的文件。 */
  readFiles: Set<string>;
}

/** 防止单个超大工具结果撑爆上下文窗口。 */
export const MAX_OUTPUT_CHARS = 30_000;

export function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const kept = text.slice(0, limit);
  return `${kept}\n\n… output truncated (${text.length - limit} more characters)`;
}
