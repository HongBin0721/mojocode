import wrapAnsi from 'wrap-ansi';

const FENCE_RE = /^\s*```/;
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * 取文本末尾,使其经 Markdown.tsx 渲染、在 `columns` 宽的终端里折行后
 * 不超过 `maxRows` 行。
 *
 * 按 `\n` 数逻辑行是不够的——一个没有换行的长段落会折成几十个终端行,
 * 动态区域照样超高。而动态区域一旦高过终端窗口,Ink 就擦不掉上一帧,
 * 每次重绘都会往回滚缓冲区漏一份旧帧,表现为满屏重复的残影。
 *
 * 行高估算必须镜像 Markdown.tsx 的两处加宽变换——代码块行加 2 列缩进、
 * 分隔线展开为 30 个 `─`——否则实际渲染高度会超过估算。折行交给
 * wrap-ansi:Ink 内部渲染用的就是它,行数估算与实际渲染一致,而且正确
 * 处理 CJK 宽度、emoji 和 ANSI 转义序列。
 */
export function tailWithinRows(text: string, maxRows: number, columns: number): string {
  const width = Math.max(20, columns);
  const lines = text.trimEnd().split('\n');

  // 每一行渲染前的代码围栏状态(前向扫描;围栏行自身 before 为其闭合前状态)。
  const before: boolean[] = [];
  let fence = false;
  for (const line of lines) {
    before.push(fence);
    if (FENCE_RE.test(line)) fence = !fence;
  }
  const inCode = (i: number) => before[i]! && !FENCE_RE.test(lines[i]!);

  // 该行按 Markdown.tsx 渲染后占用的终端行数。围栏行实际不渲染(0 行),
  // 这里仍按 1 行计——只会高估,方向安全。
  const renderedRows = (i: number): number => {
    let rendered = lines[i]!;
    if (inCode(i)) rendered = `  ${rendered}`;
    else if (!before[i] && HR_RE.test(rendered)) rendered = '─'.repeat(30);
    return wrapAnsi(rendered, width, { hard: true, trim: false }).split('\n').length;
  };

  let start = lines.length - 1;
  let rows = 0;
  let partial: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const n = renderedRows(i);
    if (rows + n > maxRows) {
      if (rows === 0) {
        // 单独一行就超过预算 → 只保留它折行后的最后几行。代码行按
        // width-2 折,渲染时补上 2 列缩进后仍不超宽。
        const w = inCode(i) ? width - 2 : width;
        partial = wrapAnsi(lines[i]!, w, { hard: true, trim: false })
          .split('\n')
          .slice(-maxRows)
          .join('\n');
        start = i;
        rows = maxRows;
      }
      break;
    }
    rows += n;
    start = i;
  }

  // 截断落在代码块中间(首行前围栏未闭合)时,预览缺少开栏行,Markdown.tsx
  // 的栏内/栏外状态会整体反转。补一个 ``` 开栏,并让出一行预算。
  if (before[start] && maxRows >= 2) {
    if (partial !== undefined) {
      const keptRows = partial.split('\n');
      if (keptRows.length + 1 > maxRows) partial = keptRows.slice(-(maxRows - 1)).join('\n');
      return '```\n' + partial;
    }
    while (rows + 1 > maxRows && start < lines.length - 1) {
      rows -= renderedRows(start);
      start++;
    }
    // 让出预算后起点可能已越过闭栏,重查一次再补。
    if (before[start]) return '```\n' + lines.slice(start).join('\n');
  }

  return partial ?? lines.slice(start).join('\n');
}

/** 列表项标记,或列表项的缩进续行。 */
const LIST_RE = /^(?:\s*(?:[-*+]|\d+[.)])\s|\s+\S)/;

/**
 * 把流式累积的文本切成「可提交定稿的完整段落」和「仍在生成的尾部」。
 *
 * 切点取最后一个安全的空行:段落一旦被空行收尾就不会再变,可以立即提交
 * 进 <Static> 时间线(Codex CLI 式的增量提交)。预览区只留正在生成的尾段,
 * 动态区高度天然受控,已生成的内容也随时可在回滚区回看。
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
