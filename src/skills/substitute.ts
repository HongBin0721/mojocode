/**
 * 技能正文的参数替换:`$ARGUMENTS` 换整串,`$0`..`$N` 换按空白切出的第 N 个词
 * (0 起)。没有对应实参的位置占位符原样保留(照抄 Claude Code 的语义——
 * 替换成空串会把 "$2 天后" 这类正文悄悄改坏)。
 */

const PLACEHOLDER = /\$(ARGUMENTS|\d+)/g;

export function substituteArgs(body: string, args: string): string {
  const trimmed = args.trim();
  const words = trimmed ? trimmed.split(/\s+/) : [];

  let replaced = false;
  const result = body.replace(PLACEHOLDER, (match, token: string) => {
    if (token === 'ARGUMENTS') {
      replaced = true;
      return trimmed;
    }
    const index = Number(token);
    if (index < words.length) {
      replaced = true;
      return words[index]!;
    }
    return match;
  });

  // 正文没写占位符但用户带了参数:按标准附在末尾,别让参数无声蒸发。
  if (!replaced && trimmed) {
    return `${result}\n\nARGUMENTS: ${trimmed}`;
  }
  return result;
}
