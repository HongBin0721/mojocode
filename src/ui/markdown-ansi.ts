import Table from 'cli-table3';
import { Marked, type MarkedExtension } from 'marked';
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
    const extension = markedTerminal({
      width,
      reflowText: false,
      showSectionPrefix: false,
      tab: 2,
    });
    patchListRendering(extension);
    patchLinkRendering(extension);
    patchTableRendering(extension, width);
    const instance = new Marked();
    instance.use(extension);
    cached = { width, instance };
  }
  const rendered = (cached.instance.parse(text, { async: false }) as string).trimEnd();
  return rendered.split('\n').flatMap((line) => wrapLine(line, width)).join('\n');
}

/** 终端宽度基本不变,缓存单个实例即可;resize 后按新宽度重建。 */
let cached: { width: number; instance: Marked } | undefined;

/** marked-terminal 内部用来占位列表标记的字符串,替换标记时要剥掉。 */
const MARKED_TERMINAL_BULLET = '* ';
/** 无序列表的项目符号,与流式预览(Markdown.tsx)保持一致,定稿前后不跳动。 */
const BULLET = '- ';

/**
 * 修掉 marked-terminal 7.3.0 在 marked 15 下的三处列表渲染缺陷。
 * 都没有上游修复(7.3.0 已是最新版),只能在这里接管对应的渲染器。
 *
 * 1. `text` 渲染器直接取 `token.text` 交差,丢掉了 marked 15 挂在
 *    `token.tokens` 上的行内子节点。紧凑列表项正是 `text` 节点,于是列表
 *    里的 `**粗体**`、`` `代码` `` 全部以原文出现——而同一篇文档里的普通
 *    段落(走 `paragraph`,它正确调用了 parseInline)却好好的。
 * 2. 它给列表项打的占位标记就是 `'* '`,与无序列表的最终符号同一个串;
 *    有序列表编号时按行扫描这个串,会把嵌套在里面的无序子项一并编号,
 *    子项因此接着父列表的序号往下排(1. 2. 下面冒出 3. 4.)。
 * 3. 紧凑列表项里的子列表,marked 不会在父项正文与子列表之间插换行,
 *    直接拼接会粘成「3. 第三项• 子项」。
 *
 * 这里自己排版列表:序号按 `start` 逐项递增、无序项用固定符号、续行按
 * 标记宽度悬挂缩进、子列表另起一行。条目正文仍交回 marked-terminal 渲染,
 * 它负责的实体反转义、emoji 与冒号占位还原都不受影响。
 */
function patchListRendering(extension: MarkedExtension): void {
  const renderer = extension.renderer;
  if (!renderer) return;
  const baseListItem = renderer.listitem;
  if (!baseListItem) return;

  renderer.text = function (token) {
    const inline = 'tokens' in token ? token.tokens : undefined;
    return inline && inline.length > 0 ? this.parser.parseInline(inline) : token.text;
  };

  // 嵌套深度。条目正文是在本函数执行期间递归渲染出来的,子列表因此能看到
  // depth > 1,据此决定要不要另起一行——不必回过头用正则去猜哪一段是子列表。
  let depth = 0;

  renderer.list = function (token) {
    depth += 1;
    try {
      // `0.` 起编的列表是合法的,不能把 0 当作"没给起始值"而顶成 1。
      const start = typeof token.start === 'number' ? token.start : 1;
      const lines: string[] = [];

      token.items.forEach((item, index) => {
        const marker = token.ordered ? `${start + index}. ` : BULLET;
        // 条目正文交回 marked-terminal;它固定返回 '\n' + '* ' + 正文。
        // 渲染器约定可以返回 false 表示走默认实现,那时自己解析条目内容。
        const raw = baseListItem.call(this, item);
        const rendered = (
          typeof raw === 'string' ? raw : this.parser.parse(item.tokens, Boolean(item.loose))
        ).trim();
        const body = rendered.startsWith(MARKED_TERMINAL_BULLET)
          ? rendered.slice(MARKED_TERMINAL_BULLET.length)
          : rendered;
        // 悬挂缩进:续行与首行正文左对齐,子列表因此逐层递进。
        const pad = ' '.repeat(marker.length);
        const [first = '', ...rest] = body.split('\n');
        lines.push(marker + first);
        for (const line of rest) lines.push(line.trim() ? pad + line : line);
      });

      const body = lines.join('\n');
      // 子列表先断行再排;顶层列表与 marked-terminal 的 section() 一致,
      // 块级元素之间空一行。
      return depth > 1 ? `\n${body}` : `${body}\n\n`;
    } finally {
      depth -= 1;
    }
  };
}

/** 单列内容预算的下限(显示列数),再窄连两个双宽汉字都放不下。 */
const MIN_CELL_CONTENT = 4;

/** marked-terminal 的 codespan 用它占位冒号,自渲染单元格时要还原。 */
const COLON_REPLACER_RE = /\*#COLON\|\*/g;

/**
 * 接管表格渲染。marked-terminal 把表格交给 cli-table3 时不传任何宽度约束,
 * 列宽按内容自然撑开:CJK 单元格(每字 2 列)很容易画出远超终端宽度的表,
 * 随后 wrapLine 的逐行硬折行把每条框线、每行单元格从中间切开,断点还因
 * 双宽字符逐行漂移,框线就成了阶梯状碎片。cli-table3 自带的 wordWrap 也
 * 救不了:按词折行拆不开无空格的中文长句,`wrapOnWordBoundary: false` 的
 * 逐字折行又按 code unit 计宽,CJK 行照样超宽后被截断。
 *
 * 这里自己排版:按可用宽度给各列分配内容预算(先按自然宽度,放不下时
 * 逐列收窄最宽者),用 wrap-ansi——显示宽度计宽、不劈双宽字符、断点处
 * 闭合并重开 ANSI 样式——把单元格预折成多行,再交给 cli-table3 画框。
 * 它按多行单元格里最宽的一行定列宽,整张表因此永远不超终端宽度,
 * wrapLine 也就不会再碰它。
 *
 * 单元格自渲染(parseInline)绕过了 marked-terminal 的 transform,这里
 * 照它的样子还原 HTML 实体与 codespan 的冒号占位;emoji 短代码转换省略
 * (它自己渲染表头时同样不做)。另外表格内的链接只保留链接文本:终端不
 * 支持超链接时 marked-terminal 会展开成 `文本 (href)`,在按列折行的
 * 单元格里徒占宽度。
 */
/**
 * 链接一律渲染成 `文字 (url)`,不发 OSC 8 超链接转义。
 *
 * marked-terminal 见 `supports-hyperlinks` 报 true(iTerm2 / WezTerm / kitty /
 * VS Code 都算)就改发 OSC 8 序列,而渲染器画的是自己的帧缓冲、并不解析
 * 这些字节——终端里看到的会是 `]8;;https://…` 这样的可见乱码。写死成带
 * 括号的形式还顺带让 URL 始终可见(全屏下没法点,能看见才能复制)。
 * 将来若接 OpenTUI 的 `<a href>`,改这里即可。
 */
function patchLinkRendering(extension: MarkedExtension): void {
  const renderer = extension.renderer;
  if (!renderer) return;

  renderer.link = function (token) {
    const text = token.tokens?.length ? this.parser.parseInline(token.tokens).trim() : token.text;
    if (!token.href) return text || '';
    return text && text !== token.href ? `${text} (${token.href})` : token.href;
  };
}

function patchTableRendering(extension: MarkedExtension, width: number): void {
  const renderer = extension.renderer;
  if (!renderer) return;
  const baseLink = renderer.link;

  // 单元格是在 table 渲染器执行期间同步递归渲染的,用标志区分表内外。
  let inTable = false;

  renderer.link = function (token) {
    if (!inTable) return baseLink ? baseLink.call(this, token) : false;
    return this.parser.parseInline(token.tokens).trim() || token.href;
  };

  renderer.table = function (token) {
    inTable = true;
    try {
      const head = token.header.map((cell) => restoreEntities(this.parser.parseInline(cell.tokens)));
      const rows = token.rows.map((row) =>
        row.map((cell) => restoreEntities(this.parser.parseInline(cell.tokens))),
      );
      const budgets = columnBudgets([head, ...rows], width);
      const wrapCells = (cells: string[]) =>
        cells.map((cell, i) =>
          wrapAnsi(cell, budgets[i] ?? MIN_CELL_CONTENT, { hard: true, trim: false }),
        );
      const table = new Table({ head: wrapCells(head) });
      for (const row of rows) table.push(wrapCells(row));
      // 与 marked-terminal 的 section() 一致,块级元素之间空一行。
      return `${table.toString()}\n\n`;
    } finally {
      inTable = false;
    }
  };
}

/**
 * 给每列分配单元格内容的显示宽度预算:总预算 = 终端宽度减去框线与
 * cli-table3 的左右 padding;自然宽度放得下就原样保留,放不下则反复
 * 收窄当前最宽的列,直到装下或所有列都到下限。
 */
function columnBudgets(rows: string[][], width: number): number[] {
  const cols = rows[0]?.length ?? 0;
  const natural: number[] = Array.from({ length: cols }, () => MIN_CELL_CONTENT);
  for (const row of rows) {
    row.forEach((cell, i) => {
      if (i >= cols) return;
      let widest = natural[i] ?? MIN_CELL_CONTENT;
      // 单元格可能已含换行(<br> 或图片),按最宽一行计。
      for (const line of cell.split('\n')) widest = Math.max(widest, stringWidth(line));
      natural[i] = widest;
    });
  }
  // 每列 2 列 padding,加 cols+1 根竖线;终端窄到连下限都装不下时保住
  // 下限,让外层 wrapLine 兜底。
  const avail = Math.max(cols * MIN_CELL_CONTENT, width - cols * 3 - 1);
  let total = natural.reduce((a, b) => a + b, 0);
  while (total > avail) {
    let widest = 0;
    natural.forEach((budget, i) => {
      if (budget > (natural[widest] ?? 0)) widest = i;
    });
    const budget = natural[widest] ?? 0;
    if (budget <= MIN_CELL_CONTENT) break;
    natural[widest] = budget - 1;
    total -= 1;
  }
  return natural;
}

/** 与 marked-terminal 的 transform(undoColon + unescapeEntities)保持一致。 */
function restoreEntities(text: string): string {
  return text
    .replace(COLON_REPLACER_RE, ':')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * 行首缩进:跳过开头的 ANSI 样式序列后,取前导空格,以及紧随其后的列表
 * 标记(`• ` / `- ` / `1. `)。把标记宽度算进缩进,折出来的续行才会挂在
 * 条目正文下方,而不是顶回行首、与下一个条目的标记混作一团。
 */
const ANSI_STYLE = `${String.fromCharCode(27)}\\[[0-9;]*m`;
const INDENT_RE = new RegExp(`^(?:${ANSI_STYLE})*( *)((?:[•\\-*+]|\\d+[.)]) +)?`);

/**
 * 把一行按显示宽度硬折为若干 ≤ width 列的行,续行补上原行的前导缩进。
 * 折行宽度按 `width - 缩进` 收窄,保证补缩进后仍不超宽;wrap-ansi 会在
 * 断点处闭合并重开 ANSI 样式,跨行样式不丢。
 */
function wrapLine(line: string, width: number): string[] {
  if (stringWidth(line) <= width) return [line];
  const indent = INDENT_RE.exec(line);
  const pad = ' '.repeat(stringWidth(`${indent?.[1] ?? ''}${indent?.[2] ?? ''}`));
  const parts = wrapAnsi(line, Math.max(20, width - pad.length), { hard: true, trim: false }).split(
    '\n',
  );
  return parts.map((part, i) => (i === 0 ? part : pad + part.trimStart()));
}
