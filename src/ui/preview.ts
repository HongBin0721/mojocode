/** 终端显示宽度:CJK 全角字符占两列,按逻辑字符数估算会严重低估。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

/** 保留 `line` 末尾不超过 `budget` 列的部分。 */
export function sliceTail(line: string, budget: number): string {
  const chars = [...line];
  let width = 0;
  let start = chars.length;
  while (start > 0) {
    const w = displayWidth(chars[start - 1]!);
    if (width + w > budget) break;
    width += w;
    start--;
  }
  return chars.slice(start).join('');
}

/**
 * 取文本末尾,使其在 `columns` 宽的终端里折行后不超过 `maxRows` 行。
 *
 * 按 `\n` 数逻辑行是不够的——一个没有换行的长段落会折成几十个终端行,
 * 动态区域照样超高。而动态区域一旦高过终端窗口,Ink 就擦不掉上一帧,
 * 每次重绘都会往回滚缓冲区漏一份旧帧,表现为满屏重复的残影。
 */
export function tailWithinRows(text: string, maxRows: number, columns: number): string {
  const width = Math.max(20, columns);
  const rowsFor = (line: string) => Math.max(1, Math.ceil(displayWidth(line) / width));
  const lines = text.trimEnd().split('\n');
  const kept: string[] = [];
  let rows = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const needed = rowsFor(line);
    if (rows + needed > maxRows) {
      // 单独一行就超过预算 → 只保留它折行后的最后几行。
      if (kept.length === 0) kept.unshift(sliceTail(line, maxRows * width));
      break;
    }
    kept.unshift(line);
    rows += needed;
  }

  return kept.join('\n');
}
