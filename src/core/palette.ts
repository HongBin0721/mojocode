/**
 * 配色表。**全产品只有这一份**:TUI 的组件读它(`src/ui/theme.ts` 原样
 * re-export 成 `theme`),扩展拿到的 `ExtensionTheme` 也把它翻成 SGR
 * (`extension-types.ts` 的 `extensionTheme`)。
 *
 * 住在 core 而不是 `src/ui/` 是被依赖方向逼出来的:`extensionTheme` 要在
 * headless(没有 TUI)下也拿得到,所以它在零依赖的 core 里;而 core 不能
 * 反过来 import `src/ui/theme.ts`(那边挂着 string-width 与 i18n)。两边各存
 * 一张表试过一次,结果是主题只染了 TUI 的边框与文字,扩展画的每一行、每个
 * `renderCall`/`renderResult`、以及退出时的整段回滚转储全都还是内置色。
 *
 * 值是 kit 认的颜色:命名色(`cyan`)或 `#rrggbb`。**可变**,由
 * `src/ui/theme-loader.ts` 的 `applyTheme` 在 render 之前就地改;读取方一律
 * 现读,不许做模块级快照(`StatusLine` 的阶段色表就栽在这上面)。
 */

/** 主题文件 `colors` 段认得的键。 */
export const THEME_COLOR_KEYS = [
  'accent',
  'user',
  'assistant',
  'dim',
  'tool',
  'error',
  'warn',
  'success',
  'added',
  'removed',
  'diffAddedBg',
  'diffAddedFg',
  'diffRemovedBg',
  'diffRemovedFg',
  'code',
] as const;

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

export const palette: Record<ThemeColorKey, string> = {
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
};

/** 命名色 → SGR 前景码。表以外的名字按"终端默认前景"处理。 */
const NAMED_SGR: Record<string, string> = {
  black: '30',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  white: '37',
  gray: '90',
  grey: '90',
  redbright: '91',
  greenbright: '92',
  yellowbright: '93',
  bluebright: '94',
  magentabright: '95',
  cyanbright: '96',
  whitebright: '97',
};

/**
 * 配色表里的一个值 → SGR 前景参数。`#rrggbb` / `#rgb` 走真彩色(终端不支持
 * 时自己降级),命名色查表,都不认识就交回 `39`(终端默认前景)——一个拼错
 * 的颜色名该退回缺省,不该让整行没颜色可画。
 */
export function sgrForeground(color: string): string {
  const value = color.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (hex) {
    const digits = hex[1]!;
    const full = digits.length === 3 ? digits.replace(/./g, (c) => c + c) : digits;
    const n = Number.parseInt(full, 16);
    return `38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
  }
  return NAMED_SGR[value] ?? '39';
}
