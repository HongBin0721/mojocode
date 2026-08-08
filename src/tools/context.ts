import type { PermissionGate } from '../permissions/gate.js';
import type { EventBus } from '../core/events.js';
import type { Permissions, PermissionRules } from '../config/schema.js';
import type { ResolvedSearchBackend } from '../config/search.js';
import type { LspManager } from '../lsp/manager.js';

/** 所有内置工具共享的状态。通过闭包传递,而非 AI SDK 的 context。 */
export interface ToolContext {
  root: string;
  gate: PermissionGate;
  bus: EventBus;
  rules: PermissionRules;
  /**
   * 本 agent 已读取过的文件——`edit` 拒绝修改未读过的文件。
   *
   * **每个 agent 一份**,子 agent 不与主 agent 共享:这个护栏要保证的是
   * "改的那个 agent 亲眼看过内容",共享会让主 agent 凭子 agent 的阅读
   * 就能编辑自己从没读过的文件。
   */
  readFiles: Set<string>;
  /** 这套工具是否给子 agent 用。只影响权限被硬拒时的措辞,见 GateCallerOptions。 */
  subagent?: boolean;
  /** LSP 诊断管理器;`lsp.enabled: false` 时为 undefined。write/edit 成功后回喂诊断。 */
  lsp?: LspManager;
  /**
   * web_search 的后端。惰性 getter 而非解析好的对象:config 会被
   * switchProvider/applyPermissions 就地修改,现取现算才不会拿到旧值
   * (与 bootstrap 里 GoalController 的 evaluatorModel 同一手法)。
   */
  searchBackend: () => ResolvedSearchBackend | undefined;
  /**
   * 方案获批后退出计划模式并还原两轴权限,返回还原到的组合。由 bootstrap
   * 注入(它才够得着系统提示词重建与会话持久化);目前只有 exit_plan 调用。
   */
  exitPlanMode: () => Permissions;
  /**
   * 额外只读根(已激活技能的目录,realpath 过)。惰性 getter,理由同
   * searchBackend:激活发生在会话中途,现取现算才拿到当下的集合。
   * 只有 read 与 glob 消费它——写路径永远只认工作区单根。
   */
  extraReadRoots: () => string[];
}

/** 防止单个超大工具结果撑爆上下文窗口。 */
export const MAX_OUTPUT_CHARS = 30_000;

export function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const kept = text.slice(0, limit);
  return `${kept}\n\n… output truncated (${text.length - limit} more characters)`;
}
