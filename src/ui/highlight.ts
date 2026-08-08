import { highlight, supportsLanguage, type Theme } from 'cli-highlight';

/**
 * 终端语法高亮的共用入口(流式预览的代码块、工具输出里的 diff)。
 *
 * 一律*逐行*高亮:预览的文本随时可能截断在语法中间,diff 更是天然的
 * 片段,整块解析反而会因为语法不完整整段失色。跨行结构(模板串、块
 * 注释)的着色因此可能有偏差,换取的是任何输入都不会崩、不会整段变色。
 */

/** markdown 围栏标注 / 文件扩展名 → highlight.js 的注册语言名。 */
const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  h: 'cpp',
  hh: 'cpp',
  sh: 'bash',
  zsh: 'bash',
  shell: 'bash',
  yml: 'yaml',
  // highlight.js 没有 toml,ini 的高亮规则最接近。
  toml: 'ini',
  html: 'xml',
  htm: 'xml',
  vue: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  jsonc: 'json',
  psl: 'perl',
  pl: 'perl',
  ex: 'elixir',
  exs: 'elixir',
};

/** 没有扩展名、靠文件名本身识别的。 */
const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
};

/** 由文件路径推断语言;认不出返回 undefined,调用方降级为无高亮。 */
export function languageFromPath(filePath: string): string | undefined {
  const name = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? '';
  const byName = FILENAME_LANGUAGES[name];
  if (byName) return byName;
  // `.bashrc` 这类以点开头的无扩展名文件,split 后首段为空,取末段即可。
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return ext ? resolveLanguage(ext) : undefined;
}

/** 归一化别名并确认 highlight.js 确实支持;不支持返回 undefined。 */
export function resolveLanguage(nameOrExt: string): string | undefined {
  const key = nameOrExt.toLowerCase();
  const language = LANGUAGE_ALIASES[key] ?? key;
  return supportsLanguage(language) ? language : undefined;
}

/**
 * 给一行代码着色。language 需已经过 resolveLanguage 归一化;传 undefined
 * 或高亮失败时返回原文,调用方据此决定要不要用单色兜底。
 */
export function highlightLine(line: string, language: string | undefined): string {
  if (!language || !line) return line;
  try {
    return highlight(line, { language, ignoreIllegals: true });
  } catch {
    return line;
  }
}

/**
 * 直接吐 truecolor SGR,不经 chalk。
 *
 * 两个理由:一是 chalk 会按 stdout 的颜色能力整体降级(非 TTY 下直接
 * 输出无色),而这些字符串最终是喂给 ansi-spans 解析、由 OpenTUI 画的,
 * 与 stdout 是不是 TTY 无关;二是 SGR 39(恢复默认前景色)在 ansi-spans
 * 里被解释为"继承外层",diff 行的浅绿/浅红前景因此能贯穿未着色的片段。
 */
function fg(hex: string): (code: string) => string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return (code) => `\x1b[38;2;${r};${g};${b}m${code}\x1b[39m`;
}

const plain = (code: string): string => code;

/**
 * diff 行专用的语法配色。
 *
 * highlight.js 的默认终端主题是给**白底**设计的:字符串/正则取红、
 * 数字/注释取绿——套在 diff 的红绿底色上就是"绿底红字"(新增行里的
 * 字符串literal 被画成红色,语义正好反过来,看着像报错),暗底上的
 * 深蓝关键字也几乎看不见。
 *
 * 这套配色因此有两条硬约束:**不用红、不用绿**(那两个色是 diff 自己的
 * 语义),且亮度都足够高——它只会画在 diffAddedBg / diffRemovedBg 这两块
 * 我们自己指定的深色底上。未覆盖的 token 会回落到 cli-highlight 的默认
 * 主题,所以默认主题里所有着色的键都必须在这里显式改写掉。
 */
const DIFF_THEME: Theme = {
  keyword: fg('#c678dd'),
  built_in: fg('#56b6c2'),
  type: fg('#56b6c2'),
  literal: fg('#d19a66'),
  number: fg('#d19a66'),
  regexp: fg('#56b6c2'),
  string: fg('#e5c07b'),
  symbol: fg('#56b6c2'),
  class: fg('#e5c07b'),
  function: fg('#61afef'),
  title: fg('#61afef'),
  comment: fg('#9199a6'),
  doctag: fg('#9199a6'),
  meta: fg('#9199a6'),
  tag: fg('#9199a6'),
  name: fg('#61afef'),
  attr: fg('#56b6c2'),
  // diff 里的 +/- 由行本身的底色表达,再着色只会和它打架。
  addition: plain,
  deletion: plain,
};

/** 同 highlightLine,但用 diff 专用配色(见 DIFF_THEME)。 */
export function highlightDiffLine(line: string, language: string | undefined): string {
  if (!language || !line) return line;
  try {
    return highlight(line, { language, ignoreIllegals: true, theme: DIFF_THEME });
  } catch {
    return line;
  }
}
