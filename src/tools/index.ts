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
      return withDiagnostics(
        t(o.created ? 'sum.writeCreated' : 'sum.writeWritten', { lines: Number(o.lines) }),
        o,
      );
    case 'edit':
      return withDiagnostics(
        o.replacements === 1 ? t('sum.editOne') : t('sum.editMany', { n: Number(o.replacements) }),
        o,
      );
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
    // 报告正文已喂给模型(通常还会被转述),摘要只报规模。被截停/出错时
    // 必须在这一行说出来——否则界面上它和一次完整调研长得一模一样。
    case 'task': {
      const size = t('sum.task', {
        steps: Number(o.steps),
        tokens: formatTokensShort(Number(o.tokens)),
      });
      return o.incomplete ? `${size} · ${t('sum.taskIncomplete')}` : size;
    }
    // 内联加载只报名字;fork 形结果(带 steps)复用 task 的规模摘要与
    // incomplete 提示——被截停的 fork 技能和被截停的子任务是同一种半成品。
    case 'skill': {
      if (o.steps === undefined) return t('sum.skill', { name: String(o.name) });
      const size = t('sum.task', {
        steps: Number(o.steps),
        tokens: formatTokensShort(Number(o.tokens)),
      });
      return o.incomplete ? `${size} · ${t('sum.taskIncomplete')}` : size;
    }
    case 'exit_plan':
      // 非计划模式下的误调也返回 approved:false,但那不是"用户打回了方案"
      // ——照直说成打回,时间线就在报告一次根本没发生过的审批。
      if (o.notApplicable) return t('sum.planNotApplicable');
      return o.approved ? t('sum.planApproved', { mode: String(o.mode) }) : t('sum.planRejected');
    default:
      return t('sum.done');
  }
}

/** write/edit 结果带 LSP 诊断时,在摘要后追加错误/警告数,一眼看出改坏了。 */
function withDiagnostics(base: string, o: Record<string, unknown>): string {
  const diag = o.diagnostics as { errors?: number; warnings?: number } | undefined;
  if (!diag) return base;
  const errors = Number(diag.errors ?? 0);
  const warnings = Number(diag.warnings ?? 0);
  if (errors > 0) return `${base} · ${t('sum.lspErrors', { n: errors })}`;
  if (warnings > 0) return `${base} · ${t('sum.lspWarnings', { n: warnings })}`;
  return base;
}

/** 与 ui/theme.ts 的 formatTokens 同形。tools 不 import ui,各留一份。 */
function formatTokensShort(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return t('ui.unknownTime');
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
