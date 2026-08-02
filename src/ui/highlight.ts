import { highlight, supportsLanguage } from 'cli-highlight';

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
