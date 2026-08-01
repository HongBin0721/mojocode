import type { ToolSet } from 'ai';
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
 * A one-line summary for the collapsed tool card in the UI. Keeping this here
 * rather than in the components means the headless `-p` renderer shows the
 * exact same text.
 */
export function summarizeToolResult(toolName: string, output: unknown): string {
  const o = output as Record<string, unknown> | undefined;
  if (!o || typeof o !== 'object') return 'done';

  switch (toolName) {
    case 'read':
      return `${o.path} (${o.shownLines} of ${o.totalLines} lines)`;
    case 'write':
      return o.changed === false
        ? `${o.path} unchanged`
        : `${o.path} ${o.created ? 'created' : 'written'}, ${o.lines} lines`;
    case 'edit':
      return `${o.path}, ${o.replacements} replacement${o.replacements === 1 ? '' : 's'}`;
    case 'glob':
      return `${o.count} file${o.count === 1 ? '' : 's'}${o.truncated ? ' (truncated)' : ''}`;
    case 'grep':
      return `${o.count} match${o.count === 1 ? '' : 'es'} via ${o.engine}`;
    case 'bash':
      if (o.timedOut) return 'timed out';
      return `exit ${o.exitCode} in ${formatMs(Number(o.durationMs))}`;
    case 'todo':
      return `${o.completed}/${o.total} done`;
    default:
      return 'done';
  }
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown time';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
