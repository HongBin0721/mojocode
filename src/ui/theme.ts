import stringWidth from 'string-width';
import { createSignal } from 'solid-js';
import { t } from '../i18n/index.js';
import { palette, type ThemeColorKey } from '../core/palette.js';

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

/**
 * 配色表住在零依赖的 `core/palette.ts`——扩展的 `ExtensionTheme` 要在 headless
 * 下也拿得到同一份,而那边 import 不到这个模块。这里转口成一个**可追踪**的
 * 读视图:每次 `theme.x` 都先读一下版本信号,组件 JSX 里的 `color={theme.x}`
 * 因此订阅了它;`/theme` 选择器里光标移到哪套配色就 `applyTheme` + `bumpTheme`,
 * 已画出的文字随之变色而不必整树重挂(选择器还开着,重挂会把它关掉)。
 * 提交时仍整树重挂兜底——不经 JSX 读色的地方(扩展组件自己拼的 SGR 行、
 * 一次性算好的字符串)不会跟着版本走。写入不走这里:`applyTheme` 直接改
 * palette 再 bump。TUI 侧既有的 `import { theme } from './theme.js'` 一个都不用改。
 */
const [themeVersion, setThemeVersion] = createSignal(0);

export const theme: Readonly<Record<ThemeColorKey, string>> = new Proxy(palette, {
  get(target, key) {
    themeVersion();
    return target[key as ThemeColorKey];
  },
});

/** palette 改完后通知所有读过 `theme.x` 的响应式节点重算。 */
export function bumpTheme(): void {
  setThemeVersion((n) => n + 1);
}

export { THEME_COLOR_KEYS, sgrForeground, type ThemeColorKey } from '../core/palette.js';

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
  thinking: '✻',
  /** 一轮的收尾行标记。 */
  turn: '▣',
  /**
   * 可展开/已展开的详情标记(思考正文、工具输出)。ctrl+r 全局切换,
   * 单宽 ASCII——这两个字符会紧贴在耗时后面,用宽度有歧义的符号会错列。
   */
  expandable: '+',
  expanded: '-',
  // 目标指示器。刻意不用 🎯:emoji 在各终端里的显示宽度不一致,会把靠右
  // 对齐的那一行算错列宽,整套字形也都是单宽几何符号。
  goal: '◎',
} as const;

/**
 * 工具在时间线上的展示名:内建工具首字母大写(Claude Code 风格),
 * MCP 等外部工具保持原名。
 */
// 定义下沉到 timeline-data.ts(GUI renderer 的 @core 白名单入口,单点维护);
// 这里 re-export 维持 TUI 侧既有 import 路径。
export { toolDisplayName } from './timeline-data.js';

/**
 * 计量条:填 `cells` 格的实心/空心方块。用几何符号而不是 emoji 方块,
 * 理由同 glyphs——单宽,不会把靠右对齐的一行算错列。
 *
 * 两处刻意的取整:用掉一点点就点亮第一格(0 与 1% 在条上必须看得出区别),
 * 而没满就绝不画满格(满条是"到顶了"的信号,89% 冒充满条会误导)。
 */
export function meterBar(ratio: number, cells: number): { filled: string; empty: string } {
  // NaN 要挡在门口:NaN 会一路穿过 min/max/round,把两段都算成空串,
  // 条突然缩成 0 列,靠右对齐的那一组跟着跳一下(用量为 0 除以 0 时的实况)。
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const on =
    clamped <= 0
      ? 0
      : clamped >= 1
        ? cells
        : Math.max(1, Math.min(cells - 1, Math.round(clamped * cells)));
  return { filled: '▰'.repeat(on), empty: '▱'.repeat(cells - on) };
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * 上下文窗口换算成选择器行尾的标注(256k / 1.0M)。所有模型选择器
 * (向导的 ModelPicker、/models 的 ModelsPicker、AuthWizard)共用。
 */
export function contextNote(window: number | undefined): string | undefined {
  return window === undefined ? undefined : t('modelpicker.context', { n: formatTokens(window) });
}

/**
 * 轮末收尾行的缓存命中段(如「 · 缓存命中 12.3k/45.6k (27%)」,自带前导
 * 分隔符——调用方无条件拼接,判空与拼段的规则收在这一个函数里)。
 * cached 是 input 中命中前缀缓存的部分;分母缺失或为 0 时返回空串——
 * provider 不报缓存、或回放旧会话没有这个字段,都不画这一段。
 * 0% 也照常返回:压缩后那一轮的全量 miss 正是用户想看到的事实。
 */
export function formatCacheHit(cached: number | undefined, input: number | undefined): string {
  if (cached === undefined || !input) return '';
  return ` · ${t('ui.turnCache', {
    cached: formatTokens(cached),
    total: formatTokens(input),
    pct: Math.round((cached / input) * 100),
  })}`;
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
    case 'skill':
      return `${String(i.name ?? '')}${i.arguments ? ` · ${String(i.arguments)}` : ''}`;
    // 不带参数:任务数在紧随其后的清单里一目了然,写进括号只是重复。
    case 'todo':
      return '';
    default: {
      const text = JSON.stringify(i);
      return text.length > 80 ? `${text.slice(0, 80)}…` : text;
    }
  }
}
