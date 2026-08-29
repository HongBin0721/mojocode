import type { TimelineItem } from './types.js';
import type { TodoItem } from '../tools/todo.js';

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
  exit_plan: 'Plan',
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

/**
 * exit_plan 调用里的方案正文。方案在**输入**里而不是结果里,所以无论批准
 * 与否都取得到——被打回的那版也留在时间线上,能看清模型改了什么。
 */
export function extractPlan(item: Extract<TimelineItem, { kind: 'tool' }>): string | undefined {
  if (item.toolName !== 'exit_plan' || item.isError) return undefined;
  // 非计划模式下的误调没有走过审批,把正文摊开会让它看起来像是提交过。
  if ((item.output as { notApplicable?: unknown } | undefined)?.notApplicable) return undefined;
  const plan = (item.input as { plan?: unknown } | undefined)?.plan;
  return typeof plan === 'string' && plan.trim() ? plan : undefined;
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
