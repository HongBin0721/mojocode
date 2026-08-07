import stringWidth from 'string-width';
import { t } from '../i18n/index.js';

/**
 * 终端文本折行宽度的安全余量(列)。
 *
 * string-width 与各终端对个别字符(emoji、CJK 标点、歧义宽度字符)的宽度
 * 判定存在 ±1 列的分歧。一行若顶满可用宽度,1 列的分歧就足以让实际折行
 * 行数比估算多一行,预览的行高预算(preview.ts)与实际渲染随之错位。
 * 因此所有随帧重绘的行(流式预览、进行中的工具行)都必须留出此边距,
 * 禁止顶格;静态时间线条目也用同一边距,让定稿文本与预览按相同宽度折行。
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
  /** plan 模式下输入框的提示符:与 thinking 的 ✻ 同族的星形,示意"在构思"。 */
  promptPlan: '✦',
  /**
   * full-access 下输入框的提示符。刻意不用 ⚡:它是 emoji 表现形,部分终端
   * 按双宽渲染会破坏对齐(同 goal 不用 🎯 的理由);↯ 是单宽的箭头区字符,
   * 闪电含义不变。
   */
  promptDanger: '↯',
  pointer: '❯',
  checked: '☒',
  unchecked: '☐',
  thinking: '✻',
  // 目标指示器。刻意不用 🎯:emoji 在各终端里的显示宽度不一致,会把靠右
  // 对齐的那一行算错列宽,整套字形也都是单宽几何符号。
  goal: '◎',
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
  web_search: 'Web Search',
  web_fetch: 'Fetch',
  // 名字里就带上动作:它不带参数,紧随其后的是整份清单。
  todo: 'Update Todos',
  exit_plan: 'Plan',
  task: 'Task',
};

export function toolDisplayName(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

/**
 * 权限档位标签的显示颜色。full-access(以及自由组合出的 danger-full-access)
 * 是危险(警示色),plan 是当下的工作方式而非危险(强调色),其余弱化。
 * Header 与 Footer 共用,避免两处各写一份三元。
 */
export function modeColor(label: string): string {
  if (label === 'full-access' || label.startsWith('danger-full-access')) return theme.warn;
  if (label === 'plan') return theme.accent;
  return theme.dim;
}

/**
 * 输入框的模式样式:边框/提示符颜色与提示符字形随权限模式变化,让"当前
 * 处于什么模式"在打字的地方就看得见,而不用扫底栏。
 *
 * 与 modeColor 的取色刻意不同:那边"其余弱化"是因为底栏是背景信息,这里
 * 常规模式(ask/auto)保持强调色——输入框是焦点,灰掉会像被禁用;read-only
 * 则确实取弱化色,"写不了东西"与"收着劲"的观感一致。
 */
export function inputModeStyle(mode: string | undefined): { color: string; glyph: string } {
  if (!mode) return { color: theme.accent, glyph: glyphs.prompt };
  if (mode === 'full-access' || mode.startsWith('danger-full-access'))
    return { color: theme.warn, glyph: glyphs.promptDanger };
  if (mode === 'plan') return { color: theme.accent, glyph: glyphs.promptPlan };
  if (mode.startsWith('read-only')) return { color: theme.dim, glyph: glyphs.prompt };
  return { color: theme.accent, glyph: glyphs.prompt };
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
 * 把 home 目录前缀缩写成 `~`,Header 与 Footer 展示路径共用。
 * 必须按路径段边界匹配:`/Users/foo` 不能把 `/Users/foobar` 缩成 `~bar`。
 */
export function shortenHome(p: string): string {
  const home = process.env.HOME?.replace(/\/+$/, '');
  if (!home) return p;
  if (p === home) return '~';
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/**
 * 压成单行并按*显示宽度*(终端列数)截断,超出补 `…`。
 *
 * 不能按字符数截:CJK 每字占 2 列,按字符数截出来的行可能宽达限值的
 * 两倍,超出可用宽度就会被迫折行,行数不再可控(见 WIDTH_SAFETY)。
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

/**
 * 同 truncateWidth,但保留*尾部*、在开头补 `…`——路径类文本尾部才是重点。
 * 按字素簇而非码点截断:macOS 路径是 NFD 形式,按码点截可能把组合重音
 * 符孤立在省略号后面,渲染成乱码。
 */
export function truncateWidthStart(text: string, maxWidth: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (stringWidth(single) <= maxWidth) return single;
  const graphemes = [...new Intl.Segmenter().segment(single)].map((s) => s.segment);
  let out = '';
  let width = 0;
  for (const g of graphemes.reverse()) {
    const w = stringWidth(g);
    // 留 1 列给省略号。
    if (width + w > maxWidth - 1) break;
    out = g + out;
    width += w;
  }
  return `…${out}`;
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
    case 'web_search':
      return String(i.query ?? '');
    case 'web_fetch':
      return String(i.url ?? '');
    // 完整 prompt 又长又是给子 agent 看的,括号里放用户可读的短标签。
    case 'task':
      return `${String(i.description ?? '')}${i.mode === 'explore' ? ' · explore' : ''}`;
    // 不带参数:任务数在紧随其后的清单里一目了然,写进括号只是重复。
    case 'todo':
      return '';
    // 同理:方案正文紧随其后完整展开,塞进括号只会被截成一行乱码。
    case 'exit_plan':
      return '';
    default: {
      const text = JSON.stringify(i);
      return text.length > 80 ? `${text.slice(0, 80)}…` : text;
    }
  }
}
