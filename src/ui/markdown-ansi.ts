import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

/**
 * 用 marked + marked-terminal 把 markdown 渲染成带 ANSI 样式的终端文本:
 * 表格画成对齐的框线表、代码块经 cli-highlight 语法高亮、标准 CommonMark
 * 行内规则(不会出现手写正则把 `*.ts` 的星号误配对的问题)。
 *
 * 只用于渲染*定稿*的消息(<Static> 时间线)。流式预览仍走 Markdown.tsx 的
 * 逐行宽松解析——marked 面对截断在语法中间的文本会整段误判,逐行处理
 * 反而更稳。
 */
export function renderMarkdownAnsi(text: string, columns: number): string {
  const width = Math.max(20, columns);
  if (!cached || cached.width !== width) {
    const instance = new Marked();
    instance.use(markedTerminal({ width, reflowText: true, showSectionPrefix: false, tab: 2 }));
    cached = { width, instance };
  }
  return (cached.instance.parse(text, { async: false }) as string).trimEnd();
}

/** 终端宽度基本不变,缓存单个实例即可;resize 后按新宽度重建。 */
let cached: { width: number; instance: Marked } | undefined;
