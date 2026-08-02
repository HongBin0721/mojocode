import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';

/**
 * 用 marked + marked-terminal 把 markdown 渲染成带 ANSI 样式的终端文本:
 * 表格画成对齐的框线表、代码块经 cli-highlight 语法高亮、标准 CommonMark
 * 行内规则(不会出现手写正则把 `*.ts` 的星号误配对的问题)。
 *
 * 折行不交给 marked-terminal:它的 `reflowText` 按*字符数*计宽,CJK 每字
 * 占 2 列,"98 宽"的配置能输出 160+ 列的行——超过终端宽度的行会被终端
 * 自动折行,行数变得不可预测。这里禁用它的 reflow,渲染后用 wrap-ansi
 * (Ink 内部与 preview.ts 用的同一套显示宽度测量)逐行硬折行,并给折出的
 * 续行保留原行的前导缩进(列表/引用的悬挂对齐)。
 *
 * 只用于渲染*定稿*的消息(<Static> 时间线)。流式预览仍走 Markdown.tsx 的
 * 逐行宽松解析——marked 面对截断在语法中间的文本会整段误判,逐行处理
 * 反而更稳。
 */
export function renderMarkdownAnsi(text: string, columns: number): string {
  const width = Math.max(20, columns);
  if (!cached || cached.width !== width) {
    const instance = new Marked();
    instance.use(markedTerminal({ width, reflowText: false, showSectionPrefix: false, tab: 2 }));
    cached = { width, instance };
  }
  const rendered = (cached.instance.parse(text, { async: false }) as string).trimEnd();
  return rendered.split('\n').flatMap((line) => wrapLine(line, width)).join('\n');
}

/** 终端宽度基本不变,缓存单个实例即可;resize 后按新宽度重建。 */
let cached: { width: number; instance: Marked } | undefined;

/** 行首缩进:跳过开头的 ANSI 样式序列后取空格。 */
const INDENT_RE = /^(?:\u001b\[[0-9;]*m)*( *)/;

/**
 * 把一行按显示宽度硬折为若干 ≤ width 列的行,续行补上原行的前导缩进。
 * 折行宽度按 `width - 缩进` 收窄,保证补缩进后仍不超宽;wrap-ansi 会在
 * 断点处闭合并重开 ANSI 样式,跨行样式不丢。
 */
function wrapLine(line: string, width: number): string[] {
  if (stringWidth(line) <= width) return [line];
  const pad = INDENT_RE.exec(line)?.[1] ?? '';
  const parts = wrapAnsi(line, Math.max(20, width - pad.length), { hard: true, trim: false }).split(
    '\n',
  );
  return parts.map((part, i) => (i === 0 ? part : pad + part.trimStart()));
}
