import type { ModelMessage } from 'ai';
import type { NewTimelineItem } from '../ui/types.js';
import { summarizeToolResult } from '../tools/index.js';
import { unwrapGuidance } from '../agent/loop.js';
import { t } from '../i18n/index.js';

/** 压缩摘要消息的开头标记,与 src/agent/compact.ts 写入的内容保持一致。 */
const COMPACT_MARKER = '[Earlier conversation, compacted]';

/**
 * 把持久化的会话历史还原成时间线条目,供 `--resume`/`/resume` 在 TUI 中回放。
 *
 * 纯数据转换,无 React 依赖(NewTimelineItem 是 type-only 引入)。与实时事件
 * 流的差异:持久历史里的 tool-result 是 AI SDK 包装过的 `ToolResultOutput`,
 * 需要解包才能喂给 summarizeToolResult;durationMs 无法从历史恢复,置 0
 * (Timeline 只显示 >1500ms 的耗时,0 不会渲染出来)。
 */
export function replayTimeline(messages: ModelMessage[]): NewTimelineItem[] {
  const items: NewTimelineItem[] = [];
  // tool-result 只带 callId,工具名与输入要从此前 assistant 消息的 tool-call 里找。
  const calls = new Map<string, { toolName: string; input: unknown }>();

  for (const message of messages) {
    if (message.role === 'system') continue;

    if (message.role === 'user') {
      const text = contentText(message.content);
      if (!text) continue;
      if (text.startsWith(COMPACT_MARKER)) {
        items.push({ kind: 'notice', level: 'info', message: t('replay.compacted') });
        continue;
      }
      // 运行中插入的引导消息持久化的是包装后的版本;时间线还原为原文。
      items.push({ kind: 'user', text: unwrapGuidance(text) ?? text });
      continue;
    }

    if (message.role === 'assistant') {
      if (typeof message.content === 'string') {
        if (message.content.trim()) items.push({ kind: 'assistant', text: message.content });
        continue;
      }
      for (const part of message.content) {
        if (part.type === 'text') {
          if (part.text.trim()) items.push({ kind: 'assistant', text: part.text });
        } else if (part.type === 'reasoning') {
          if (part.text.trim()) items.push({ kind: 'reasoning', text: part.text });
        } else if (part.type === 'tool-call') {
          calls.set(part.toolCallId, { toolName: part.toolName, input: part.input });
        } else if (part.type === 'tool-result') {
          // provider 侧执行的工具(罕见)会把结果直接放进 assistant 消息。
          items.push(toolItem(part.toolCallId, part.toolName, part.output, calls));
        }
      }
      continue;
    }

    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue;
        items.push(toolItem(part.toolCallId, part.toolName, part.output, calls));
      }
    }
  }

  return items;
}

function toolItem(
  callId: string,
  toolName: string,
  wrapped: unknown,
  calls: Map<string, { toolName: string; input: unknown }>,
): NewTimelineItem {
  const call = calls.get(callId);
  const { output, isError } = unwrapToolOutput(wrapped);
  const summary = isError
    ? String(typeof output === 'string' ? output : JSON.stringify(output) ?? '')
        .split('\n')[0]!
        .slice(0, 120) // 镜像 loop.ts 对 tool-error 的摘要方式
    : summarizeToolResult(toolName, output);
  return {
    kind: 'tool',
    toolName: call?.toolName ?? toolName,
    input: call?.input,
    summary,
    output,
    isError,
    durationMs: 0,
  };
}

/**
 * 解包 AI SDK 的 `ToolResultOutput`(`{type:'text'|'json'|'error-text'|
 * 'error-json'|'content', value}`)。历史文件可能来自旧版本或手工修改,
 * 形状不认识时原样返回。
 */
function unwrapToolOutput(wrapped: unknown): { output: unknown; isError: boolean } {
  if (typeof wrapped === 'object' && wrapped !== null && 'type' in wrapped && 'value' in wrapped) {
    const { type, value } = wrapped as { type: string; value: unknown };
    switch (type) {
      case 'text':
      case 'json':
      case 'content':
        return { output: value, isError: false };
      case 'error-text':
      case 'error-json':
        return { output: value, isError: true };
    }
  }
  return { output: wrapped, isError: false };
}

/** esc-esc 回退选择器的一项:历史中的一条用户消息。 */
export interface RewindEntry {
  /** 在完整历史数组中的下标——回退即 `history.slice(0, index)`。 */
  index: number;
  /** 第几条用户消息(1 起),用于提示文案。 */
  ordinal: number;
  text: string;
}

/**
 * 收集可作为回退目标的用户消息(压缩摘要不算;引导消息还原为原文)。
 * 最新的在前——回退大多是"撤销刚才那句"。
 */
export function collectRewindEntries(messages: ModelMessage[]): RewindEntry[] {
  const entries: RewindEntry[] = [];
  messages.forEach((message, index) => {
    if (message.role !== 'user') return;
    const text = contentText(message.content);
    if (!text || text.startsWith(COMPACT_MARKER)) return;
    entries.push({ index, ordinal: entries.length + 1, text: unwrapGuidance(text) ?? text });
  });
  return entries.reverse();
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
