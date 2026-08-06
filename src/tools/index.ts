import type { ToolSet } from 'ai';
import { t } from '../i18n/index.js';
import { createFileTools } from './files.js';
import { createSearchTools } from './search.js';
import { createBashTool } from './bash.js';
import { createWebTools } from './web.js';
import { createTodoTool, TodoStore } from './todo.js';
import { createExitPlanTool } from './plan.js';
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
    // web_fetch 恒在;web_search 仅在解析出搜索后端(有 key)时注册。
    ...createWebTools(ctx),
    todo: createTodoTool(todos),
    exit_plan: createExitPlanTool(ctx),
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
    // query/URL 不进摘要,理由同 read:工具行的 `Web Search(query)` 已经写着它。
    case 'web_search':
      if (o.timedOut) return t('sum.webTimeout');
      if (o.count === 0) return t('sum.webSearchEmpty');
      return t('sum.webSearch', { n: Number(o.count), backend: String(o.backend) });
    case 'web_fetch':
      if (o.timedOut) return t('sum.webTimeout');
      if (o.unsupported) return t('sum.webFetchUnsupported');
      if (typeof o.status === 'number' && o.status >= 400) {
        return t('sum.webFetchStatus', { status: String(o.status) });
      }
      return t('sum.webFetch', { chars: String((o.content as string | undefined)?.length ?? 0) });
    case 'todo':
      return t('sum.todo', { done: Number(o.completed), total: Number(o.total) });
    case 'exit_plan':
      // 非计划模式下的误调也返回 approved:false,但那不是"用户打回了方案"
      // ——照直说成打回,时间线就在报告一次根本没发生过的审批。
      if (o.notApplicable) return t('sum.planNotApplicable');
      return o.approved ? t('sum.planApproved', { mode: String(o.mode) }) : t('sum.planRejected');
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
