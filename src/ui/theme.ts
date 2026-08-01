import { t } from '../i18n/index.js';

export const theme = {
  accent: 'cyan',
  user: 'green',
  assistant: 'white',
  dim: 'gray',
  tool: 'blue',
  error: 'red',
  warn: 'yellow',
  success: 'green',
  added: 'green',
  removed: 'red',
} as const;

export const glyphs = {
  bullet: '●',
  branch: '⎿',
  pending: '○',
  running: '◐',
  done: '✓',
  failed: '✗',
  prompt: '›',
  pointer: '❯',
} as const;

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** 工具参数的紧凑单行摘要,显示在工具名旁边。 */
export function formatToolInput(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case 'read':
      return String(i.path ?? '');
    case 'write':
    case 'edit':
      return String(i.path ?? '');
    case 'glob':
      return String(i.pattern ?? '');
    case 'grep':
      return `${String(i.pattern ?? '')}${i.include ? ` · ${String(i.include)}` : ''}`;
    case 'bash':
      return String(i.command ?? '');
    case 'todo':
      return t('ui.nTasks', { n: Array.isArray(i.todos) ? i.todos.length : 0 });
    default: {
      const text = JSON.stringify(i);
      return text.length > 80 ? `${text.slice(0, 80)}…` : text;
    }
  }
}
