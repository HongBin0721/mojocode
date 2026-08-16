/**
 * DiffView 行号解析测试:hunk 头起算,old/new 各自按行种推进。
 */

import { describe, expect, it } from 'vitest';
import { commentTargetOf, looksLikeDiff, parseDiffLines } from '../src/renderer/components/DiffView.js';

const sample = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@
 line1
-old2
+new2
 line3`;

describe('parseDiffLines', () => {
  it('hunk 行号按行种推进:context 双号、del 只推 old、add 只推 new', () => {
    const lines = parseDiffLines(sample);
    const byText = Object.fromEntries(lines.map((l) => [l.text, l]));
    expect(byText[' line1']).toMatchObject({ kind: 'context', oldLine: 1, newLine: 1 });
    expect(byText['-old2']).toMatchObject({ kind: 'del', oldLine: 2 });
    expect(byText['+new2']).toMatchObject({ kind: 'add', newLine: 2 });
    expect(byText[' line3']).toMatchObject({ kind: 'context', oldLine: 3, newLine: 3 });
  });

  it('多个 hunk 各自从头起算', () => {
    const lines = parseDiffLines('@@ -10,2 +10,2 @@\n a\n-b\n+c\n@@ -50 +50 @@\n x');
    const lastContext = lines.at(-1)!;
    expect(lastContext).toMatchObject({ oldLine: 50, newLine: 50 });
  });

  it('looksLikeDiff 以 @@ 判定', () => {
    expect(looksLikeDiff(sample)).toBe(true);
    expect(looksLikeDiff('npm test\n')).toBe(false);
  });
});

describe('commentTargetOf', () => {
  it('del 行用 oldLine/old 侧;add/context 用 newLine/new 侧;meta/hunk 不可评论', () => {
    const lines = parseDiffLines(sample);
    expect(commentTargetOf(lines.find((l) => l.kind === 'del')!)).toEqual({ line: 2, side: 'old' });
    expect(commentTargetOf(lines.find((l) => l.kind === 'add')!)).toEqual({ line: 2, side: 'new' });
    expect(commentTargetOf(lines.find((l) => l.kind === 'context')!)).toEqual({ line: 1, side: 'new' });
    expect(commentTargetOf(lines.find((l) => l.kind === 'hunk')!)).toBeUndefined();
    expect(commentTargetOf(lines.find((l) => l.kind === 'meta')!)).toBeUndefined();
  });
});
