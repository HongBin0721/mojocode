/**
 * 近似语法高亮分词器(移植自设计稿的 tokenize()):零依赖单正则,按扩展名
 * 切关键字集(Go / TS-JS / Python 三套近似)。输出 token 的 kind 对应
 * tokens.less 的 --tok-* 色;含 CJK 的整行按弱色处理由调用方判断
 * (hasCjk)。准确率换体积:diff/工具 detail 的辅助着色足够,不引 highlight.js。
 */

export type TokenKind = 'kw' | 'ty' | 'str' | 'num' | 'cm' | 'fn' | 'pn' | 'id' | 'ws';

export interface Token {
  t: string;
  kind: TokenKind;
}

const GO_KEYWORDS = new Set([
  'func', 'if', 'else', 'for', 'return', 'type', 'interface', 'struct', 'var', 'const',
  'defer', 'go', 'range', 'package', 'import', 'nil', 'true', 'false', 'switch', 'case',
  'break', 'continue', 'chan', 'select', 'map',
]);
const TS_KEYWORDS = new Set([
  'function', 'if', 'else', 'for', 'while', 'return', 'type', 'interface', 'class', 'var',
  'let', 'const', 'import', 'export', 'from', 'default', 'null', 'undefined', 'true', 'false',
  'new', 'this', 'async', 'await', 'switch', 'case', 'break', 'continue', 'try', 'catch',
  'finally', 'throw', 'extends', 'implements', 'readonly', 'typeof', 'in', 'of', 'as',
]);
const PY_KEYWORDS = new Set([
  'def', 'if', 'elif', 'else', 'for', 'while', 'return', 'class', 'import', 'from', 'as',
  'None', 'True', 'False', 'and', 'or', 'not', 'in', 'is', 'try', 'except', 'finally',
  'raise', 'with', 'lambda', 'yield', 'pass', 'break', 'continue', 'global', 'async', 'await',
]);
const COMMON_TYPES = new Set([
  'string', 'error', 'int', 'int64', 'bool', 'context', 'time', 'Duration', 'Context',
  'number', 'boolean', 'void', 'unknown', 'never', 'object', 'Promise', 'Array', 'Record',
  'Map', 'Set', 'str', 'float', 'list', 'dict', 'tuple', 'bytes', 'T',
]);

function keywordsFor(lang: string | undefined): Set<string> {
  switch (lang) {
    case 'go':
      return GO_KEYWORDS;
    case 'py':
    case 'python':
      return PY_KEYWORDS;
    default:
      return TS_KEYWORDS;
  }
}

/** 从文件路径推断语言标识(扩展名);认不出返回 undefined(按 TS 集处理)。 */
export function langOf(path: string | undefined): string | undefined {
  const ext = path?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (!ext) return undefined;
  if (ext === 'go') return 'go';
  if (ext === 'py') return 'python';
  return ext;
}

const CJK_RE = /[一-龥]/;

/** 行内是否含中日韩汉字——含则整行按弱色渲染(设计稿判据),不跑分词。 */
export function hasCjk(line: string): boolean {
  return CJK_RE.test(line);
}

// 标点类排除引号/反引号:贪婪的 `(",` 会把字符串的开引号吞进标点段,
// 让字符串分支永远匹配不上(`f("hi")` 的经典触雷)。
const TOKEN_RE =
  /(\/\/[^\n]*|#[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([^\sA-Za-z0-9_"'`]+|["'`])/g;

/** 一行文本 → 着色 token 序列。空白 token 的 kind 为 'ws'(继承外层色)。 */
export function tokenize(line: string, lang?: string): Token[] {
  const keywords = keywordsFor(lang);
  const out: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(line)) !== null) {
    const [t, cm, str, num, word, ws] = match;
    if (cm !== undefined) out.push({ t, kind: 'cm' });
    else if (str !== undefined) out.push({ t, kind: 'str' });
    else if (num !== undefined) out.push({ t, kind: 'num' });
    else if (word !== undefined) {
      if (keywords.has(word)) out.push({ t, kind: 'kw' });
      else if (COMMON_TYPES.has(word)) out.push({ t, kind: 'ty' });
      else if (line[TOKEN_RE.lastIndex] === '(') out.push({ t, kind: 'fn' });
      else out.push({ t, kind: 'id' });
    } else if (ws !== undefined) out.push({ t, kind: 'ws' });
    else out.push({ t, kind: 'pn' });
  }
  return out;
}
