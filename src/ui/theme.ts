import stringWidth from 'string-width';
import { t } from '../i18n/index.js';

/**
 * 终端文本折行宽度的安全余量(列)。
 *
 * string-width 与各终端对个别字符(emoji、CJK 标点、歧义宽度字符)的宽度
 * 判定存在 ±1 列的分歧。一行若顶满终端最后一列,1 列的分歧就足以触发终端
 * 自动折行——帧的实际行数比 Ink 记账的多一行,之后每次重绘 `eraseLines`
 * 都少擦一行、起笔向下漂一行,在上方遗弃一行永不重写的空行。流式输出下
 * 重绘每秒发生数十次,几秒就会在回滚区积累成片的空白。因此所有随帧重绘的
 * 行(流式预览、进行中的工具行)都必须留出此边距,禁止顶格;静态时间线
 * 条目也用同一边距,让定稿文本与预览按相同宽度折行。
 */
export const WIDTH_SAFETY = 4;

export const theme = {
  accent: 'cyan',
  /**
   * 用户自己发出的消息。刻意不用 success 的绿色——工具行的 ● 已经占了
   * 绿色,同色会让"谁说的"变模糊;青色与输入框的提示符同色,打进去的和
   * 回滚区里记下的是同一抹颜色。
   */
  user: 'cyan',
  assistant: 'white',
  dim: 'gray',
  tool: 'blue',
  error: 'red',
  warn: 'yellow',
  success: 'green',
  added: 'green',
  removed: 'red',
  /**
   * diff 行的背景高亮(Claude Code 风格)。前景与背景都显式指定:
   * 背景取深色、前景取浅色,不依赖终端的默认前景色,深浅色主题下
   * 对比度都够;不支持真彩色的终端由 chalk 自动降到 256 色近似。
   */
  diffAddedBg: '#1e4023',
  diffAddedFg: '#b6e3bc',
  diffRemovedBg: '#4a2226',
  diffRemovedFg: '#f2b8bd',
  /** markdown 中的行内代码与代码块。 */
  code: 'cyan',
} as const;

export const glyphs = {
  bullet: '⏺',
  branch: '⎿',
  pending: '○',
  running: '◐',
  done: '✓',
  failed: '✗',
  prompt: '›',
  pointer: '❯',
  checked: '☒',
  unchecked: '☐',
} as const;

/**
 * 工具在时间线上的展示名:内建工具首字母大写(Claude Code 风格),
 * MCP 等外部工具保持原名。
 */
const TOOL_LABELS: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  bash: 'Bash',
  // 名字里就带上动作:它不带参数,紧随其后的是整份清单。
  todo: 'Update Todos',
};

export function toolDisplayName(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

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

/**
 * 压成单行并按*显示宽度*(终端列数)截断,超出补 `…`。
 *
 * 不能按字符数截:CJK 每字占 2 列,按字符数截出来的行可能宽达限值的
 * 两倍,超过终端宽度的行会被终端自动折行;若该行随帧重绘,还会引发
 * Ink 擦除记账的逐帧漂移(见 WIDTH_SAFETY)。
 */
export function truncateWidth(text: string, maxWidth: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (stringWidth(single) <= maxWidth) return single;
  let out = '';
  let width = 0;
  for (const ch of single) {
    const w = stringWidth(ch);
    // 留 1 列给省略号。
    if (width + w > maxWidth - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
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
    // 不带参数:任务数在紧随其后的清单里一目了然,写进括号只是重复。
    case 'todo':
      return '';
    default: {
      const text = JSON.stringify(i);
      return text.length > 80 ? `${text.slice(0, 80)}…` : text;
    }
  }
}
