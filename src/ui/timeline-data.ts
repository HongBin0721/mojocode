import type { TimelineItem } from './types.js';
import type { TodoItem } from '../tools/todo.js';

/**
 * tool 条目的纯数据提取,Timeline(渲染)与 transcript(退出 dump)共用。
 * 刻意独立成无 React/渲染器依赖的模块:transcript 也被 Node 测试直接
 * import,不能经 Timeline 连带拉进 kit → @opentui(模块加载期就要 FFI)。
 */

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
