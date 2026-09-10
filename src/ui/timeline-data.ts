import type { TimelineItem } from './types.js';

/**
 * todo 清单的一项。类型住在这里而不是 todo 扩展里:扩展模块带 ai/zod 的
 * 运行时依赖,而本文件是 GUI renderer 的 @core 白名单入口,必须保持 Node-free
 * (扩展反过来从这里 import)。
 */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** 从任意来源(会话记录、线上快照)认出一份清单;形状不对返回 undefined。 */
export function parseTodos(data: unknown): TodoItem[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const valid = data.filter(
    (item): item is TodoItem =>
      typeof (item as TodoItem | undefined)?.content === 'string' &&
      ['pending', 'in_progress', 'completed'].includes((item as TodoItem).status),
  );
  return valid.length === data.length ? valid : undefined;
}

/**
 * tool 条目的纯数据提取,Timeline(渲染)与 transcript(退出 dump)共用。
 * 刻意独立成无 UI 框架/渲染器依赖的模块:transcript 也被 Node 测试直接
 * import,不能经 Timeline 连带拉进 kit → @opentui(模块加载期就要 FFI);
 * 也是 GUI renderer 的 @core 白名单入口——放这里的东西必须保持 Node-free。
 */

/** 工具显示名(Title Case)。theme.ts re-export 给 TUI;GUI 经 @core 别名直用。 */
const TOOL_LABELS: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  bash: 'Bash',
  web_search: 'Web Search',
  web_fetch: 'Fetch',
  // 名字里就带上动作:它不带参数,紧随其后的是整份清单。
  todo: 'Update Todos',
  task: 'Task',
  skill: 'Skill',
};

export function toolDisplayName(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

/**
 * 展开态正文:按 toolName 显式取各工具结果里最有信息量的字符串字段——
 * "每个工具的结果长什么样"是产出方的知识,放共享层而不是让渲染层猜。
 * 未知工具走通用字段梯子,都取不到才退回整个结果对象的 JSON。
 */
export function extractOutputText(toolName: string, output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>;
    const str = (key: string) => (typeof obj[key] === 'string' ? (obj[key] as string) : undefined);
    switch (toolName) {
      case 'read':
      case 'web_fetch': {
        const text = str('content') ?? str('text');
        if (text !== undefined) return text;
        break;
      }
      case 'bash': {
        const text = str('output');
        if (text !== undefined) return text;
        break;
      }
      case 'grep': {
        const text = str('matches');
        if (text !== undefined) return text;
        break;
      }
      case 'glob': {
        if (Array.isArray(obj.files)) return obj.files.map((file) => String(file)).join('\n');
        break;
      }
      case 'web_search': {
        if (Array.isArray(obj.results) && obj.results.length > 0) {
          return obj.results
            .map((result) => {
              const entry = result as { title?: unknown; url?: unknown };
              return [entry.title, entry.url].filter((v) => typeof v === 'string').join('\n');
            })
            .join('\n\n');
        }
        break;
      }
    }
    const generic =
      str('output') ?? str('content') ?? str('matches') ?? str('text') ?? str('message');
    if (generic !== undefined) return generic;
  }
  try {
    return JSON.stringify(output, null, 2) ?? '';
  } catch {
    return String(output);
  }
}

export function extractDiff(item: Extract<TimelineItem, { kind: 'tool' }>): string | undefined {
  if (item.isError) return undefined;
  const output = item.output as { diff?: unknown } | undefined;
  return typeof output?.diff === 'string' ? output.diff : undefined;
}

/** 成功的 todo 调用返回其输入里的完整任务列表,用于渲染清单。 */
export function extractTodos(
  item: Extract<TimelineItem, { kind: 'tool' }>,
): TodoItem[] | undefined {
  if (item.toolName !== 'todo' || item.isError) return undefined;
  const todos = (item.input as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos)) return undefined;
  const valid = todos.filter(
    (todo): todo is TodoItem =>
      typeof (todo as TodoItem | undefined)?.content === 'string' &&
      typeof (todo as TodoItem | undefined)?.status === 'string',
  );
  return valid.length > 0 ? valid : undefined;
}

/**
 * 走时用的时长:整秒,不带小数(`12s` / `1m04s`)。
 *
 * 与两个前端各自的 `formatDuration`(工具耗时,一分钟内带一位小数 `4.2s`)
 * 是**两种东西**:那是一段已经结束的耗时,小数是精度;而这个挂在扩展状态行
 * 上每秒跳一次,尾数只是噪音。放在这里而不是 TUI 里,是因为 GUI 的
 * `StatusLine` 渲染的是同一批 `ExtensionStatusEntry.since`,两边必须同形——
 * 之前 GUI 复用 `formatDuration` 于是同一条目在 TUI 显示 `12s`、在 GUI 显示
 * `12.3s`。timeline-data 是 renderer 的 `@core` 白名单入口,零 Node 依赖。
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}
