import type { PermissionGate } from '../permissions/gate.js';
import type { EventBus } from '../core/events.js';
import type { Permissions, PermissionRules } from '../config/schema.js';

/** 所有内置工具共享的状态。通过闭包传递,而非 AI SDK 的 context。 */
export interface ToolContext {
  root: string;
  gate: PermissionGate;
  bus: EventBus;
  rules: PermissionRules;
  /** 本会话中 agent 已读取过的文件——`edit` 拒绝修改未读过的文件。 */
  readFiles: Set<string>;
  /**
   * 方案获批后退出计划模式并还原两轴权限,返回还原到的组合。由 bootstrap
   * 注入(它才够得着系统提示词重建与会话持久化);目前只有 exit_plan 调用。
   */
  exitPlanMode: () => Permissions;
}

/** 防止单个超大工具结果撑爆上下文窗口。 */
export const MAX_OUTPUT_CHARS = 30_000;

export function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const kept = text.slice(0, limit);
  return `${kept}\n\n… output truncated (${text.length - limit} more characters)`;
}
