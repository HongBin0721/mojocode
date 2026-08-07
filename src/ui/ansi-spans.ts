/**
 * ANSI SGR 转义序列 → 样式段(span)解析器。
 *
 * OpenTUI 的 <text> 不解析 ANSI(转义字节会按字面渲染成 `[31m` 乱码,
 * T0 探针①实测),而本项目的全部定稿格式化资产——renderMarkdownAnsi、
 * highlightLine、diff 背景色、cli-table3 表格——输出的都是 ANSI 字符串。
 * 这个解析器把它们转成 {text, fg, bg, ...} 样式段,由 kit 的 <Text>
 * 渲染成 OpenTUI 的 <span>,让这些资产原样存活。
 *
 * 语义对齐 chalk:39/49(重置前景/背景)把 fg/bg 置回
 * undefined,渲染层解释为「继承外层」——Diff.tsx 的 +/- 背景高亮依赖
 * 这一行为(内层语法高亮的 reset-fg 恢复成外层 diff 前景色)。
 */

export interface AnsiSpan {
  text: string;
  /** 十六进制色或 CSS 颜色名;undefined = 继承外层。 */
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
}

/** 文本里是否含转义序列(粗判,足够作 fast path)。 */
export function hasAnsi(text: string): boolean {
  return text.includes('\x1b');
}

/** 标准 16 色(xterm 默认调色板)。30-37 / 90-97 与 40-47 / 100-107 共用。 */
const BASIC_COLORS = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
] as const;

/** xterm 256 色索引 → 十六进制。 */
function indexedColor(n: number): string {
  if (n < 16) return BASIC_COLORS[n] ?? '#ffffff';
  if (n >= 232) {
    // 24 级灰阶
    const v = 8 + (n - 232) * 10;
    const h = v.toString(16).padStart(2, '0');
    return `#${h}${h}${h}`;
  }
  // 6×6×6 色立方
  const i = n - 16;
  const steps = [0, 95, 135, 175, 215, 255] as const;
  const r = steps[Math.floor(i / 36) % 6] ?? 0;
  const g = steps[Math.floor(i / 6) % 6] ?? 0;
  const b = steps[i % 6] ?? 0;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
}

/** 消费 38/48 后面的扩展色参数,返回 [颜色, 消耗的参数个数]。 */
function extendedColor(params: number[], at: number): [string | undefined, number] {
  const mode = params[at + 1];
  if (mode === 5) {
    const n = params[at + 2];
    return [n === undefined ? undefined : indexedColor(n), 2];
  }
  if (mode === 2) {
    const r = params[at + 2] ?? 0;
    const g = params[at + 3] ?? 0;
    const b = params[at + 4] ?? 0;
    return [
      `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`,
      4,
    ];
  }
  return [undefined, 0];
}

function applySgr(style: Style, params: number[]): void {
  for (let i = 0; i < params.length; i += 1) {
    const p = params[i] ?? 0;
    switch (p) {
      case 0:
        for (const k of Object.keys(style) as (keyof Style)[]) delete style[k];
        break;
      case 1: style.bold = true; break;
      case 2: style.dim = true; break;
      case 3: style.italic = true; break;
      case 4: style.underline = true; break;
      case 7: style.inverse = true; break;
      case 9: style.strikethrough = true; break;
      case 22: delete style.bold; delete style.dim; break;
      case 23: delete style.italic; break;
      case 24: delete style.underline; break;
      case 27: delete style.inverse; break;
      case 29: delete style.strikethrough; break;
      case 39: delete style.fg; break;
      case 49: delete style.bg; break;
      case 38: {
        const [color, used] = extendedColor(params, i);
        if (color !== undefined) style.fg = color;
        i += used;
        break;
      }
      case 48: {
        const [color, used] = extendedColor(params, i);
        if (color !== undefined) style.bg = color;
        i += used;
        break;
      }
      default:
        if (p >= 30 && p <= 37) style.fg = BASIC_COLORS[p - 30];
        else if (p >= 90 && p <= 97) style.fg = BASIC_COLORS[p - 90 + 8];
        else if (p >= 40 && p <= 47) style.bg = BASIC_COLORS[p - 40];
        else if (p >= 100 && p <= 107) style.bg = BASIC_COLORS[p - 100 + 8];
        // 其余(闪烁、隐藏等)忽略。
        break;
    }
  }
}

/**
 * 转义序列:CSI(`ESC [ 参数 中间字节 终止字节`,SGR 以 m 结尾)与 OSC
 * (`ESC ] … BEL` 或 `ESC ] … ESC \`)。识别不了样式的一律整段丢弃只留
 * 可见文字——渲染器不解析这些字节,漏过去会显示成乱码。
 *
 * 参数类必须涵盖 CSI 的完整参数字节 0x30–0x3F(数字、`;`、冒号形 SGR
 * `38:5:196`、私有模式前缀 `?`,如藏光标的 `\x1b[?25l`)与中间字节
 * 0x20–0x2F,终止字节是 0x40–0x7E 全范围:bash 工具的原始输出会带
 * spinner 的光标控制、`--color=always` 的冒号色,这些都从 BashOutput
 * 直接流进 <Text>,漏一类就是一类可见的 `[?25l` 伪影。
 */
// eslint-disable-next-line no-control-regex
const ESC_RE = /\x1b\[([\x30-\x3f]*)[\x20-\x2f]*([\x40-\x7e])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * 把含转义序列的文本切成样式段。无样式文本得到单段;非 SGR 的序列
 * (光标移动、OSC 等)被静默剥掉,只保留可见文字。
 */
export function parseAnsiSpans(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const style: Style = {};
  let last = 0;
  ESC_RE.lastIndex = 0;
  for (let m = ESC_RE.exec(text); m !== null; m = ESC_RE.exec(text)) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index), ...style });
    last = ESC_RE.lastIndex;
    if (m[2] === 'm' && !(m[1] ?? '').includes('?')) {
      // 冒号是 SGR 子参数分隔符(ITU T.416),38:5:196 与 38;5;196 同义。
      const params = (m[1] ?? '').split(/[;:]/).map((s) => (s === '' ? 0 : Number(s)));
      applySgr(style, params);
    }
  }
  if (last < text.length) spans.push({ text: text.slice(last), ...style });
  return spans;
}
