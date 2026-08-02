import type { ToolSet } from 'ai';
import { t } from '../i18n/index.js';
import { createFileTools } from './files.js';
import { createSearchTools } from './search.js';
import { createBashTool } from './bash.js';
import { createTodoTool, TodoStore } from './todo.js';
import type { ToolContext } from './context.js';

export { TodoStore } from './todo.js';
export type { TodoItem } from './todo.js';
export type { ToolContext } from './context.js';

export function createBuiltinTools(ctx: ToolContext, todos: TodoStore): ToolSet {
  const files = createFileTools(ctx);
  const search = createSearchTools(ctx);

  return {
    read: files.read,
    write: files.write,
    edit: files.edit,
    glob: search.glob,
    grep: search.grep,
    bash: createBashTool(ctx),
    todo: createTodoTool(todos),
  };
}

/**
 * UI 中折叠工具卡片的一行摘要。放在这里而不是组件里,是为了让 headless
 * `-p` 渲染器显示完全相同的文本。它只用于 UI,所以做了本地化——不同于
 * 工具*结果*,后者要回传给模型,保持英文。
 */
export function summarizeToolResult(toolName: string, output: unknown): string {
  const o = output as Record<string, unknown> | undefined;
  if (!o || typeof o !== 'object') return t('sum.done');

  switch (toolName) {
    // 路径不进摘要:工具行的 `Read(path)` 已经写着它,重复一遍反而挤掉信息。
    case 'read':
      return t('sum.read', { shown: String(o.shownLines), total: String(o.totalLines) });
    case 'write':
      if (o.changed === false) return t('sum.writeUnchanged');
      return t(o.created ? 'sum.writeCreated' : 'sum.writeWritten', { lines: Number(o.lines) });
    case 'edit':
      return o.replacements === 1
        ? t('sum.editOne')
        : t('sum.editMany', { n: Number(o.replacements) });
    case 'glob':
      return t(o.truncated ? 'sum.globTruncated' : 'sum.globFiles', { n: Number(o.count) });
    case 'grep':
      return o.count === 1
        ? t('sum.grepOne', { engine: String(o.engine) })
        : t('sum.grepMany', { n: Number(o.count), engine: String(o.engine) });
    case 'bash':
      if (o.timedOut) return t('sum.bashTimeout');
      return t('sum.bashExit', { code: String(o.exitCode), time: formatMs(Number(o.durationMs)) });
    case 'todo':
      return t('sum.todo', { done: Number(o.completed), total: Number(o.total) });
    default:
      return t('sum.done');
  }
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return t('ui.unknownTime');
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
