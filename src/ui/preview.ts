import wrapAnsi from 'wrap-ansi';

const FENCE_RE = /^\s*```/;
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * 取文本末尾,使其在 `columns` 宽的终端里渲染后**恰好**占 `maxRows` 行
 * (内容不足时从头生长)。两个调用方:流式正文的活动条目(经 Markdown.tsx
 * 渲染,超长代码块只显示尾部)和流式思考的尾部窗口(纯 `<Text>` 渲染,
 * 思考动辄几千行、定稿又收成一行,留个小窗口原地刷新)。
 *
 * 按 `\n` 数逻辑行是不够的——一个没有换行的长段落会折成几十个终端行,
 * 窗口照样超出行数预算。
 *
 * **高度必须钉死而不是不超过**:窗口挂在粘底的 scrollbox 尾部,高度每变
 * 一行,上方整条时间线就跟着上下跳一行。按整行取舍时,一个折成多行的长
 * 段落(中文思考的常态)会让窗口高度随行滑动在几个值之间来回摆——流式
 * 期间最刺眼的抖动。所以装不下的首行要**拦腰截断**,只保留它折行后的
 * 最后几行,窗口高度就此恒定。
 *
 * 行高估算必须与实际渲染一致:markdown 渲染镜像 Markdown.tsx 的变换
 * (围栏行不渲染、代码块行加 2 列缩进、分隔线展开为 30 个 `─`);纯文本
 * 渲染(`markdown: false`)不做任何变换,围栏行就是普通一行。折行交给
 * wrap-ansi:与 markdown-ansi.ts 的硬折行同一套显示宽度测量,而且正确
 * 处理 CJK 宽度、emoji 和 ANSI 转义序列。
 */
export function tailWithinRows(
  text: string,
  maxRows: number,
  columns: number,
  opts?: { markdown?: boolean },
): string {
  const markdown = opts?.markdown !== false;
  const width = Math.max(20, columns);
  const lines = text.trimEnd().split('\n');
  const wrapRows = (s: string, w: number) => wrapAnsi(s, w, { hard: true, trim: false }).split('\n').length;

  // 每一行渲染前的代码围栏状态(前向扫描;围栏行自身 before 为其闭合前状态)。
  // 纯文本渲染不认围栏,跳过整趟扫描——思考动辄几千行,每个 delta 都要过一遍。
  const before: boolean[] | undefined = markdown ? [] : undefined;
  if (before) {
    let fence = false;
    for (const line of lines) {
      before.push(fence);
      if (FENCE_RE.test(line)) fence = !fence;
    }
  }

  // 该行渲染后占用的终端行数。markdown 变换:围栏行不渲染(0 行——也按
  // 0 计,否则窗口含围栏行时实际高度比预算矮一行,围栏滑过窗口又是一跳);
  // 栏内行补 2 列缩进后折行;栏外分隔线展开为 30 个 ─。
  const renderedRows = (i: number): number => {
    const line = lines[i]!;
    if (before) {
      if (FENCE_RE.test(line)) return 0;
      if (before[i]) return wrapRows(`  ${line}`, width);
      if (HR_RE.test(line)) return wrapRows('─'.repeat(30), width);
    }
    return wrapRows(line, width);
  };

  // 从尾部累加整行,装不下的那一行截断,只留它折行后的最后 keep 行。
  // 截断按该行的**渲染形态**折行(与 renderedRows 同一套变换):分隔线截出
  // 的短行不再是 HR,按普通行渲染;代码行例外——截原始行、按 width-2 折,
  // 渲染时补上 2 列缩进后恰好不超宽(把缩进烤进截断结果会被再缩进一次)。
  const sliceTail = (i: number, keep: number): string => {
    let source = lines[i]!;
    let w = width;
    if (before?.[i]) {
      w = width - 2;
    } else if (before && !before[i] && HR_RE.test(lines[i]!)) {
      source = '─'.repeat(30);
    }
    return wrapAnsi(source, w, { hard: true, trim: false }).split('\n').slice(-keep).join('\n');
  };

  let start = lines.length; // 窗口里第一条**完整**行的下标
  let rows = 0;
  let prefix: string | undefined; // 被截断的首行(保留其尾部折行行)
  for (let i = lines.length - 1; i >= 0; i--) {
    const n = renderedRows(i);
    if (rows + n <= maxRows) {
      rows += n;
      start = i;
      continue;
    }
    const keep = maxRows - rows;
    if (keep > 0) {
      prefix = sliceTail(i, keep);
      start = i + 1;
    }
    break;
  }

  const body = lines.slice(start).join('\n');
  let out = prefix === undefined ? body : prefix + (body ? `\n${body}` : '');

  // 截断落在代码块中间(首行前围栏未闭合)时,预览缺少开栏行,Markdown.tsx
  // 的栏内/栏外状态会整体反转。补一个 ``` 开栏;它自身不渲染,不占预算。
  const firstIdx = prefix === undefined ? start : start - 1;
  if (before?.[firstIdx]) out = '```\n' + out;

  return out;
}

/** 列表项标记,或列表项的缩进续行。 */
const LIST_RE = /^(?:\s*(?:[-*+]|\d+[.)])\s|\s+\S)/;

/**
 * 把流式累积的文本切成「可提交定稿的完整段落」和「仍在生成的尾部」。
 *
 * 切点取最后一个安全的空行:段落一旦被空行收尾就不会再变,可以立即定稿
 * 进时间线(Codex CLI 式的增量提交)。正在生成的尾段作为时间线尾部的活动
 * 条目原地生长——可变区始终只有一小段,每个 delta 重渲染的成本不随消息
 * 变长而膨胀,定稿条目则不可变、走 <For> 引用复用与 markdown 缓存。
 *
 * 两类空行不能作为切点:
 * - 代码围栏内的空行,跨过会把代码块劈成两半;
 * - 跨越同一个列表的空行(前后都是列表行)。松散列表 `1. 一\n\n2. 二` 是
 *   *一个*列表,拆开后每个片段都作为独立 markdown 文档渲染,有序号会各自
 *   从 1 重新开始、嵌套续行会丢掉缩进。
 *
 * 表格行之间没有空行,不会被切开。
 */
export function splitCommitted(text: string): { committed: string; rest: string } {
  const lines = text.split('\n');
  const isBlank = (i: number) => lines[i]!.trim() === '';

  let fence = false;
  let offset = 0;
  let cut = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) fence = !fence;
    offset += line.length + 1; // 计入换行符
    // 最后一行之后没有内容,段落是否完结未知,不能作为切点。
    if (fence || i >= lines.length - 1 || !isBlank(i)) continue;

    let prev = i - 1;
    while (prev >= 0 && isBlank(prev)) prev--;
    if (prev >= 0 && LIST_RE.test(lines[prev]!)) {
      let next = i + 1;
      while (next < lines.length && isBlank(next)) next++;
      // 末行仍在流式接收中,可能才收到 `2` 而 `. ` 尚未到达——此时判断不出
      // 它是不是列表项,只能保守地不切。列表后面出现完整的非列表行时才提交。
      if (next >= lines.length - 1 || LIST_RE.test(lines[next]!)) continue;
    }

    cut = offset;
  }
  if (cut === 0) return { committed: '', rest: text };
  return { committed: text.slice(0, cut).trimEnd(), rest: text.slice(cut) };
}
