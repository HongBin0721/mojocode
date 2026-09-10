import type { LanguageModel } from 'ai';
import type { EventBus } from '../core/events.js';

/** 所有内置工具共享的状态。通过闭包传递,而非 AI SDK 的 context。 */
export interface ToolContext {
  root: string;
  bus: EventBus;
  /**
   * 本 agent 已读取过的文件——`edit` 拒绝修改未读过的文件。
   *
   * **每个 agent 一份**,子 agent 不与主 agent 共享:这个护栏要保证的是
   * "改的那个 agent 亲眼看过内容",共享会让主 agent 凭子 agent 的阅读
   * 就能编辑自己从没读过的文件。
   */
  readFiles: Set<string>;
  /**
   * view_image 工具的视觉模型(读图返回文字描述)。惰性 getter 而非构造
   * 好的实例:visionModel 解析依赖 config 与当前 provider,两者都会被
   * switchProvider 就地改。解析不出(无配置且 provider 预设没有 visionModel)
   * 时为 undefined——工具随之不注册。
   */
  visionModel: () => LanguageModel | undefined;
}

/** 防止单个超大工具结果撑爆上下文窗口。 */
export const MAX_OUTPUT_CHARS = 30_000;

export function truncate(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const kept = text.slice(0, limit);
  return `${kept}\n\n… output truncated (${text.length - limit} more characters)`;
}
