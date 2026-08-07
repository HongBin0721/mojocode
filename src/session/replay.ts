import type { ModelMessage } from 'ai';
import type { NewTimelineItem } from '../ui/types.js';
import { summarizeToolResult } from '../tools/index.js';
import { unwrapGuidance } from '../agent/loop.js';
import { unwrapAttachments } from '../app/attachments.js';
import { isInitPrompt } from '../agent/init.js';
import { t } from '../i18n/index.js';

/** 压缩摘要消息的开头标记,与 src/agent/compact.ts 写入的内容保持一致。 */
const COMPACT_MARKER = '[Earlier conversation, compacted]';

/**
 * 把持久化的会话历史还原成时间线条目,供 `--resume`/`/resume` 在 TUI 中回放。
 *
 * 纯数据转换,无 UI 框架依赖(NewTimelineItem 是 type-only 引入)。与实时事件
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
      const images = imageLabels(message.content);
      if (!text && images.length === 0) continue;
      if (text.startsWith(COMPACT_MARKER)) {
        items.push({ kind: 'notice', level: 'info', message: t('replay.compacted') });
        continue;
      }
      // /init 的完整指令在历史里;时间线还原为当时输入的命令本身。
      if (isInitPrompt(text)) {
        items.push({ kind: 'user', text: '/init' });
        continue;
      }
      // 运行中插入的引导消息持久化的是包装后的版本;@ 引用展开的消息同理。
      // 两层信封可能嵌套(运行中提交的消息也会展开 @),依次解开。
      items.push({ kind: 'user', text: joinWithImages(unwrapUserText(text), images) });
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
          // 与实时渲染一致,只还原一行标记;历史里没有耗时,省掉。
          if (part.text.trim()) items.push({ kind: 'reasoning' });
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
    const images = imageLabels(message.content);
    if ((!text && images.length === 0) || text.startsWith(COMPACT_MARKER)) return;
    // /init 显示为命令本身:回退到它会把 `/init` 填回输入框,重发即重跑。
    entries.push({
      index,
      ordinal: entries.length + 1,
      text: isInitPrompt(text) ? '/init' : joinWithImages(unwrapUserText(text), images),
    });
  });
  return entries.reverse();
}

/** 依次解开引导包装与 @ 附件信封,还原用户当时输入的原文。 */
function unwrapUserText(text: string): string {
  const inner = unwrapGuidance(text) ?? text;
  return unwrapAttachments(inner) ?? inner;
}

/**
 * 消息里随附图片(file part)的展示标签。图片本身无法在终端时间线里
 * 呈现,用 `[image: 文件名]` 占位,纯图片消息因此不会从回放里消失。
 */
function imageLabels(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (part): part is { type: 'file'; filename?: string; mediaType?: string } =>
        typeof part === 'object' && part !== null && (part as { type?: string }).type === 'file',
    )
    .map((part) => `[image: ${part.filename ?? part.mediaType ?? 'file'}]`);
}

/** 原文与图片标签拼成一行;注意标签必须在信封解包之后追加。 */
function joinWithImages(text: string, images: string[]): string {
  if (images.length === 0) return text;
  return text ? `${text} ${images.join(' ')}` : images.join(' ');
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
