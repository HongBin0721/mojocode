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
 * `src/ui/theme-loader.ts` 的 `applyTheme` 就地改(启动时 render 之前一次,
 * 之后 `/theme` 随时换);读取方一律现读,不许做模块级快照(`StatusLine`
 * 的阶段色表就栽在这上面)。内置配色另存一份冻结的 `BUILTIN_PALETTE`,
 * 换主题时没给的键从它恢复——否则上一个主题设过的键会漏到下一个主题里。
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

/** 内置配色的冻结快照:`applyTheme` 的基线,`/theme default` 回到它。 */
export const BUILTIN_PALETTE: Readonly<Record<ThemeColorKey, string>> = Object.freeze({ ...palette });

/** 主题文件 `colors` 段(与扩展 `ui.getTheme` / `ui.setTheme` 交换的形状):没写的键取内置配色。 */
export type ThemeColors = Partial<Record<ThemeColorKey, string>>;

/**
 * 就地覆盖配色表:给了的键取主题值,没给的键回到内置配色;返回被改掉的键数。
 * 改的是这**一张**表,TUI 的组件与扩展的 `ExtensionTheme` 因此一起变色。传空
 * 对象即回到内置配色。**只改表不通知**:通知 TUI 重算(`bumpTheme`)是 ui 侧
 * 的事——这一步住在零依赖的 core 里,是因为 headless 下扩展的 `ui.setTheme`
 * 也要让 `extensionTheme.fg` 立刻换色,而 core 不能 import solid-js。
 */
/**
 * 异步换色的排号。换主题要先读盘,几路写入者(`/theme` 选择器的预览、`/theme`
 * 提交、主题文件热重载、扩展的 `ui.setTheme`)的读盘可能交错完成;按**完成**
 * 顺序落地会让先发起的盖掉后发起的。每个写入者在发起时领一个号,读完盘问
 * 「我还是最新的吗」,不是就放弃。**全产品一个号段**——配色表只有一张,各管
 * 各的代数(曾经是预览一个、扩展一个)防不住跨写入者的交错,还得手工互相
 * 递增才勉强接上。同步的写入(收回预览)也领号:它要让在飞的预览作废。
 */
let paletteWriteSeq = 0;
export function claimPaletteWrite(): () => boolean {
  const mine = ++paletteWriteSeq;
  return () => mine === paletteWriteSeq;
}

export function applyPalette(colors: ThemeColors): number {
  let changed = 0;
  for (const key of THEME_COLOR_KEYS) {
    const value = colors[key] ?? BUILTIN_PALETTE[key];
    if (palette[key] !== value) {
      palette[key] = value;
      changed += 1;
    }
  }
  return changed;
}

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
