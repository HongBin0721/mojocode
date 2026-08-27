import type { ModelMessage } from 'ai';
import type { NewTimelineItem, TimelineImage } from '../ui/types.js';
import { summarizeToolResult } from '../tools/index.js';
import { unwrapGuidance } from '../agent/loop.js';
import { unwrapAttachments } from '../app/attachments.js';
import { unwrapImagesEnvelope } from '../app/image-defer.js';
import { isInitPrompt } from '../agent/init.js';
import { unwrapSkillPrompt } from '../skills/invocation.js';
import { t } from '../i18n/index.js';
import { COMPACT_MARKER } from '../agent/compact.js';

export interface ReplayOptions {
  /**
   * 随用户条目带出图片字节(base64)的总预算,按字符数计。**不给就一张不带**
   * ——终端画不了图,只渲染 `[image: …]` 标签,字节纯属白扛内存;能画图的
   * 前端(GUI)自己按传输成本定预算(那份回放要经 IPC 结构化克隆,每次切
   * 焦点一次)。预算从最新的消息往回花,超出的旧图退回纯标签。
   * 一个字段同时表达"要不要"与"要多少",没有"要图但预算为 0"这种无效组合。
   */
  imageBudget?: number;
}

/**
 * 把持久化的会话历史还原成时间线条目,供 `--resume`/`/resume` 在 TUI 中回放。
 *
 * 纯数据转换,无 UI 框架依赖(NewTimelineItem 是 type-only 引入)。与实时事件
 * 流的差异:持久历史里的 tool-result 是 AI SDK 包装过的 `ToolResultOutput`,
 * 需要解包才能喂给 summarizeToolResult;durationMs 无法从历史恢复,置 0
 * (Timeline 只显示 >1500ms 的耗时,0 不会渲染出来)。
 */
export function replayTimeline(
  messages: ModelMessage[],
  options: ReplayOptions = {},
): NewTimelineItem[] {
  const items: NewTimelineItem[] = [];
  // tool-result 只带 callId,工具名与输入要从此前 assistant 消息的 tool-call 里找。
  const calls = new Map<string, { toolName: string; input: unknown }>();

  for (const message of messages) {
    if (message.role === 'system') continue;

    if (message.role === 'user') {
      const text = contentText(message.content);
      const files = filePartsOf(message.content);
      // 字节与标签二选一,同一张图不会既带字节又留标签:带了字节的图由前端
      // 画出来,再留一行 `[image: …]` 就是重复占行;没带字节的(调用方没要图、
      // 数据损坏,或稍后被预算裁掉)才需要标签当痕迹。判据留在产生方——让渲染
      // 层拿字符串去反推该剥哪条标签,是把一份跨进程的格式契约摊成两份。
      const carried: TimelineImage[] = [];
      const images: string[] = [];
      for (const part of files) {
        const image = options.imageBudget ? renderableImage(part) : undefined;
        if (image) carried.push(image);
        else images.push(imageLabel(part));
      }
      if (!text && files.length === 0) continue;
      if (text.startsWith(COMPACT_MARKER)) {
        items.push({ kind: 'notice', level: 'info', message: t('replay.compacted') });
        continue;
      }
      // /init 的完整指令在历史里;时间线还原为当时输入的命令本身。
      if (isInitPrompt(text)) {
        items.push({ kind: 'user', text: '/init' });
        continue;
      }
      // 斜杠技能同理:历史里是展开后的正文,时间线还原成 `/name args`。
      const skillCommand = unwrapSkillPrompt(text);
      if (skillCommand) {
        items.push({ kind: 'user', text: skillCommand });
        continue;
      }
      // 运行中插入的引导消息持久化的是包装后的版本;@ 引用展开的消息同理。
      // 两层信封可能嵌套(运行中提交的消息也会展开 @),依次解开。
      items.push({
        kind: 'user',
        text: joinWithImages(unwrapUserText(text), images),
        ...(carried.length > 0 ? { images: carried } : {}),
      });
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
          // 与实时渲染一致,默认只还原一行标记;正文留着供 ctrl+r 展开
          // (历史里没有耗时,省掉)。
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

  return options.imageBudget ? applyImageBudget(items, options.imageBudget) : items;
}

/**
 * 从最新的条目往回花预算,超出后的旧条目摘掉字节、把 `[image: …]` 标签补回
 * 正文——痕迹不丢,前端也不必知道预算这回事。倒着走是关键:正着累加会保住
 * 最老的图,而用户回来看的是最近几条。累加值单调不减,一旦超了就一直超,
 * 所以一趟走完即可。
 */
function applyImageBudget(items: NewTimelineItem[], budget: number): NewTimelineItem[] {
  let spent = 0;
  const out = [...items];
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const item = out[i]!;
    if (item.kind !== 'user' || !item.images) continue;
    spent += item.images.reduce((sum, image) => sum + image.data.length, 0);
    if (spent <= budget) continue;
    const { images, ...rest } = item;
    out[i] = { ...rest, text: joinWithImages(rest.text, images.map(imageLabel)) };
  }
  return out;
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
    // /init 与斜杠技能都显示为命令本身:回退到它会把命令填回输入框,重发即重跑。
    entries.push({
      index,
      ordinal: entries.length + 1,
      text: isInitPrompt(text)
        ? '/init'
        : (unwrapSkillPrompt(text) ?? joinWithImages(unwrapUserText(text), images)),
    });
  });
  return entries.reverse();
}

/** 依次解开引导包装、@ 附件信封与图片降级信封,还原用户当时输入的原文。 */
function unwrapUserText(text: string): string {
  const inner = unwrapGuidance(text) ?? text;
  const unattached = unwrapAttachments(inner) ?? inner;
  return unwrapImagesEnvelope(unattached) ?? unattached;
}

type FilePart = { type: 'file'; data?: unknown; filename?: string; mediaType?: string };

/** 消息内容里的 file part(图片)。纯图片消息靠它不从回放里消失。 */
function filePartsOf(content: unknown): FilePart[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is FilePart =>
      typeof part === 'object' && part !== null && (part as { type?: string }).type === 'file',
  );
}

/**
 * 能真正渲染的图片(GUI 缩略图);没有可用 base64 的 part 返回 undefined,
 * 由调用方退回标签——老会话或损坏记录里 data 可能不是字符串,硬造一个空串
 * 会让 GUI 画出裂图,而那张图连痕迹都不剩。
 */
function renderableImage(part: FilePart): TimelineImage | undefined {
  if (typeof part.data !== 'string' || part.data.length === 0) return undefined;
  return {
    mediaType: part.mediaType ?? 'application/octet-stream',
    data: part.data,
    ...(part.filename ? { filename: part.filename } : {}),
  };
}

/**
 * 图片在纯文本里的痕迹。**唯一定义处**:画不了图的前端拿它当占位,预算裁掉
 * 字节时也拿它把痕迹补回去,格式因此只有一份。
 */
function imageLabel(part: { filename?: string; mediaType?: string }): string {
  return `[image: ${part.filename ?? part.mediaType ?? 'file'}]`;
}

/** file part 的占位标签形态(rewind 选择器等纯文本消费方)。 */
function imageLabels(content: unknown): string[] {
  return filePartsOf(content).map(imageLabel);
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
