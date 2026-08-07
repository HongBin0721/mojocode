import { renderMarkdownAnsi } from './markdown-ansi.js';
import { extractDiff, extractPlan, extractTodos } from './timeline-data.js';
import { formatDuration, formatToolInput, glyphs, toolDisplayName, truncateWidth } from './theme.js';
import type { TimelineItem } from './types.js';
import { APP_NAME } from '../config/paths.js';
import { t } from '../i18n/index.js';

const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[39m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[39m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[39m`;

/**
 * 把时间线序列化成纯文本(带少量 ANSI 着色),供 TUI 退出后写回主屏。
 *
 * alternate screen 里画过的内容随退出全部消失;这份 dump 接在用户原有的
 * 终端历史之后,让整场会话仍然留在原生 scrollback 里可回看、可复制。
 * 版式尽量贴近时间线本身(> 用户 / ⏺ 回复与工具 / ⎿ 摘要)。
 */
export function formatTranscript(items: TimelineItem[], columns: number): string {
  const width = Math.max(40, columns);
  const out: string[] = [];
  for (const item of items) {
    switch (item.kind) {
      case 'banner':
        out.push(
          DIM(
            `── ${APP_NAME} · ${item.providerLabel} · ${item.model} · ${item.mode} · ${item.root} ──`,
          ),
        );
        break;
      case 'user':
        out.push('', CYAN(`> ${item.text}`));
        break;
      case 'assistant': {
        const body = renderMarkdownAnsi(item.text, width - 2).split('\n');
        out.push('', `${glyphs.bullet} ${body[0] ?? ''}`, ...body.slice(1).map((l) => `  ${l}`));
        break;
      }
      case 'reasoning':
        out.push(
          '',
          DIM(
            `${glyphs.thinking} ${
              item.durationMs
                ? t('ui.thoughtFor', { duration: formatDuration(item.durationMs) })
                : t('ui.thought')
            }`,
          ),
        );
        break;
      case 'tool': {
        // 保真度对齐时间线本身:方案正文、diff、todo 清单与 bash 输出都是
        // 用户在屏幕上看过的内容,dump 丢了它们就违背了"整场会话可回看"的
        // 承诺(exit_plan 的方案在批准后尤其是唯一留档)。
        const args = formatToolInput(item.toolName, item.input);
        out.push(
          '',
          `${glyphs.bullet} ${toolDisplayName(item.toolName)}${args ? DIM(`(${truncateWidth(args, 100)})`) : ''}`,
        );
        const todos = extractTodos(item);
        const plan = extractPlan(item);
        if (todos) {
          for (const todo of todos) {
            const box = todo.status === 'completed' ? glyphs.checked : glyphs.unchecked;
            out.push(`  ${DIM(`${box} ${todo.content}`)}`);
          }
        } else if (plan) {
          out.push(
            ...renderMarkdownAnsi(plan, width - 2)
              .split('\n')
              .map((l) => `  ${l}`),
          );
          out.push(`  ${DIM(`${glyphs.branch}  ${item.summary}`)}`);
        } else {
          out.push(`  ${DIM(`${glyphs.branch}  ${truncateWidth(item.summary, 160)}`)}`);
        }
        const diff = extractDiff(item);
        if (diff) out.push(...diff.trimEnd().split('\n').map((l) => `     ${DIM(l)}`));
        if (item.toolName === 'bash' && !item.isError) {
          const text = (item.output as { output?: unknown } | undefined)?.output;
          if (typeof text === 'string' && text.trim() && text !== '(no output)') {
            // 与时间线同限:前 12 行、每行 200 字符。
            const lines = text.split('\n');
            out.push(...lines.slice(0, 12).map((l) => `     ${DIM(l.slice(0, 200))}`));
            if (lines.length > 12) {
              out.push(`     ${DIM(t('ui.moreLines', { n: lines.length - 12 }))}`);
            }
          }
        }
        break;
      }
      case 'notice':
        out.push('', item.level === 'warn' ? YELLOW(`! ${item.message}`) : DIM(`· ${item.message}`));
        break;
      case 'error':
        out.push('', RED(`${glyphs.failed} ${item.message}`));
        break;
      case 'divider':
        out.push('', DIM(`── ${item.label} ──`));
        break;
      case 'collapsed':
        // dump 用的是全量 items,不含 /focus 的占位条目;留个空分支保证
        // switch 穷尽,新增 kind 时 satisfies never 会在编译期报出来。
        break;
      default:
        item satisfies never;
    }
  }
  return `${out.join('\n')}\n`;
}
