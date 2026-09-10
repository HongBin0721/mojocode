/**
 * 时间线渲染期分组(纯函数,不动共享数据模型):
 *  1. 连续的只读探索工具(read/glob/grep/web_search/web_fetch)合并成一条
 *     「探索」聚合卡,段内穿插的思考条目一并收进组里(Codex Explored 式)——
 *     连续 8 次 Read 不再是 8 张同权重卡片;
 *  2. 「微思考」(空文本或单行极短)不再独立成条,并进下一张普通工具卡的
 *     meta 区(时长 + 悬停可见原文);空文本且无处可挂的思考直接丢弃。
 *  3. todo 去重:模型每推进一步就重发整份清单,只有最后一次渲染完整
 *     TodoList,更早的压成一行差分(完成了 X / 新增 X)——完整清单已由
 *     TodoPanel 常驻承载。
 * 分组只发生在渲染层,items 本身不可变,store/回放/持久化零改动。
 */

import type { TimelineItem } from '@core/types';
import { extractTodos } from '@core/timeline-data';

export type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;
export type ReasoningItem = Extract<TimelineItem, { kind: 'reasoning' }>;
type TodoItem = NonNullable<ReturnType<typeof extractTodos>>[number];

/** 可聚合的只读探索工具。写类/bash/task 各有自己的呈现,不进组。 */
const EXPLORE_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
]);

/** 微思考判据:单行且不超过这个字数(空文本恒为微思考)。 */
const MICRO_REASONING_MAX = 30;

export interface GroupOptions {
  /**
   * 流式进行中(agent isRunning):尾部还没被后续条目关上的探索段/微思考
   * 先不动——第二个工具落地就回溯收组,会把用户正展开阅读的卡 remount 掉。
   * 回放/已收尾的会话传 false(默认),尾部照常成组,两种打开方式渲染一致。
   */
  open?: boolean;
}

export interface ExploreEntry {
  kind: 'explore';
  key: string;
  /** 组内条目按原顺序保留(展开时逐条渲染,信息不丢)。 */
  steps: (ToolItem | ReasoningItem)[];
  /** 读取的文件数(按 path 去重)。 */
  reads: number;
  /** glob/grep 次数。 */
  searches: number;
  /** web_search/web_fetch 次数。 */
  web: number;
  /** 组内被吸收的思考总时长(0 表示无可计时的思考)。 */
  thoughtMs: number;
  /** 组内工具总耗时。 */
  durationMs: number;
}

/** 非末次 todo 调用的一行差分(文案在组件层走 i18n,这里只带结构)。 */
export interface TodoUpdateEntry {
  kind: 'todo-update';
  key: string;
  /** 相比上一份清单新完成的条目。 */
  completed: string[];
  /** 相比上一份清单新增的条目(首份清单即全部)。 */
  added: string[];
}

export type TimelineEntry =
  | { kind: 'item'; item: TimelineItem; thoughtMs?: number; thoughtText?: string }
  | TodoUpdateEntry
  | ExploreEntry;

function isExploreTool(item: TimelineItem): item is ToolItem {
  return item.kind === 'tool' && EXPLORE_TOOLS.has(item.toolName) && !item.isError;
}

/** 失败的探索工具不进组:错误要保持显眼,让它自己成卡。 */
function isRunMember(item: TimelineItem): item is ToolItem | ReasoningItem {
  return item.kind === 'reasoning' || isExploreTool(item);
}

function isMicroReasoning(item: ReasoningItem): boolean {
  const text = item.text.trim();
  return text === '' || (!text.includes('\n') && text.length <= MICRO_REASONING_MAX);
}

/** todo 走专门卡片,没有 meta 区可挂思考。 */
function isPlainToolCard(item: ToolItem): boolean {
  return item.toolName !== 'todo';
}

function makeExplore(steps: (ToolItem | ReasoningItem)[]): ExploreEntry {
  const readPaths = new Set<string>();
  let reads = 0;
  let searches = 0;
  let web = 0;
  let thoughtMs = 0;
  let durationMs = 0;
  for (const step of steps) {
    if (step.kind === 'reasoning') {
      thoughtMs += step.durationMs ?? 0;
      continue;
    }
    durationMs += step.durationMs;
    if (step.toolName === 'read') {
      const path = (step.input as { path?: unknown } | undefined)?.path;
      if (typeof path === 'string') readPaths.add(path);
      else reads++;
    } else if (step.toolName === 'glob' || step.toolName === 'grep') {
      searches++;
    } else {
      web++;
    }
  }
  reads += readPaths.size;
  const first = steps[0];
  return {
    kind: 'explore',
    key: `explore:${first ? first.key : ''}`,
    steps,
    reads,
    searches,
    web,
    thoughtMs,
    durationMs,
  };
}

/** 与上一份清单做差分:新完成的 / 新增的条目。 */
function diffTodos(
  prev: TodoItem[] | undefined,
  next: TodoItem[],
): Pick<TodoUpdateEntry, 'completed' | 'added'> {
  const prevByContent = new Map((prev ?? []).map((todo) => [todo.content, todo.status]));
  const completed: string[] = [];
  const added: string[] = [];
  for (const todo of next) {
    const before = prevByContent.get(todo.content);
    if (before === undefined) added.push(todo.content);
    else if (before !== 'completed' && todo.status === 'completed') completed.push(todo.content);
  }
  return { completed, added };
}

export function groupTimeline(
  items: readonly TimelineItem[],
  { open = false }: GroupOptions = {},
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  // 最后一次成功 todo 调用的下标:只有它渲染完整清单,更早的压成差分行。
  let lastTodoIndex = -1;
  for (let k = items.length - 1; k >= 0; k--) {
    const item = items[k]!;
    if (item.kind === 'tool' && extractTodos(item) !== undefined) {
      lastTodoIndex = k;
      break;
    }
  }
  let prevTodos: TodoItem[] | undefined;

  let i = 0;
  while (i < items.length) {
    const item = items[i]!;

    // 1) 探索段:扫出最长的「探索工具 + 思考」连续段,尾部思考退回主流
    //    (它是对下一步的思考,吞进组会让紧随的回复显得没头没脑)。
    //    流式(open)时段必须被一个非段成员「关上」(j < items.length)才成组;
    //    真实一轮收尾总有 turn/回复条目落在工具后面,届时自然成组。
    if (isRunMember(item)) {
      let j = i;
      let toolCount = 0;
      while (j < items.length && isRunMember(items[j]!)) {
        if (items[j]!.kind === 'tool') toolCount++;
        j++;
      }
      let end = j;
      while (end > i && items[end - 1]!.kind === 'reasoning') end--;
      if (toolCount >= 2 && (!open || j < items.length)) {
        entries.push(makeExplore(items.slice(i, end) as (ToolItem | ReasoningItem)[]));
        i = end;
        continue;
      }
    }

    // 2) 微思考:并进下一张普通工具卡;空文本且挂不上就丢弃。流式(open)时
    //    同样的尾部保护:目标工具是最后一条时不折(它刚落地,正显示着的
    //    思考块不该在这一瞬缩成 hover-only 的 chip),等后续条目关上再折。
    if (item.kind === 'reasoning' && isMicroReasoning(item)) {
      const next = items[i + 1];
      const foldTarget =
        next !== undefined && next.kind === 'tool' && isPlainToolCard(next) ? next : undefined;
      if (foldTarget !== undefined && (!open || i + 2 < items.length)) {
        entries.push({
          kind: 'item',
          item: foldTarget,
          thoughtMs: item.durationMs,
          thoughtText: item.text.trim() || undefined,
        });
        i += 2;
        continue;
      }
      // 空文本丢弃:后面跟着可挂的工具时留给上面的折叠路径,否则一旦有
      // 后续条目就丢——流式尾部(最后一条)始终原样展示,不闪没。
      if (
        item.text.trim() === '' &&
        foldTarget === undefined &&
        (!open || i < items.length - 1)
      ) {
        i++;
        continue;
      }
    }

    // 3) todo 去重:非末次调用压成一行差分,末次照常渲染完整清单。
    if (item.kind === 'tool') {
      const todos = extractTodos(item);
      if (todos !== undefined) {
        if (i !== lastTodoIndex) {
          entries.push({ kind: 'todo-update', key: item.key, ...diffTodos(prevTodos, todos) });
        } else {
          entries.push({ kind: 'item', item });
        }
        prevTodos = todos;
        i++;
        continue;
      }
    }

    // 4) 其余原样透传。
    entries.push({ kind: 'item', item });
    i++;
  }
  return entries;
}
