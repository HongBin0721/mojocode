/**
 * unified diff 视图:解析 @@ hunk 头推进行号(old/new 双列),增/删/上下文
 * 语义着色。两种用法:纯查看(timeline 工具卡、权限卡——不传回调)与
 * Review 面板(传 onLineClick 启用行评论)。文本经 React 转义,无注入面。
 */

import React, { useMemo } from 'react';
import { hasCjk, tokenize } from '../utils/tokenize.js';

export interface ParsedDiffLine {
  kind: 'add' | 'del' | 'context' | 'hunk' | 'meta' | 'plain';
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** 判定文本是否是 unified diff(与 TUI PermissionPrompt 同一判据)。 */
export function looksLikeDiff(text: string): boolean {
  return text.includes('@@');
}

/** hunk 头 `@@ -a,b +c,d @@`:解析 + 按行种类推进行号。 */
export function parseDiffLines(diff: string): ParsedDiffLine[] {
  const out: ParsedDiffLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  for (const text of diff.split('\n')) {
    // 补丁头(git 版 unified diff 的前几行)一律 meta:不带行号、可整体隐藏。
    // 不识别的话 `diff --git`/`index` 因为不以 +/- 开头会被当成上下文行,
    // 在带行号的视图里凭空多出两行"代码"。
    if (
      text.startsWith('+++') ||
      text.startsWith('---') ||
      text.startsWith('diff --git ') ||
      text.startsWith('index ') ||
      text.startsWith('new file mode') ||
      text.startsWith('deleted file mode') ||
      text.startsWith('old mode') ||
      text.startsWith('new mode') ||
      text.startsWith('similarity index') ||
      text.startsWith('rename from') ||
      text.startsWith('rename to') ||
      text.startsWith('\\ No newline')
    ) {
      out.push({ kind: 'meta', text });
      continue;
    }
    if (text.startsWith('@@')) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      oldLine = match ? Number(match[1]) : undefined;
      newLine = match ? Number(match[2]) : undefined;
      out.push({ kind: 'hunk', text });
      continue;
    }
    if (text.startsWith('+')) {
      out.push({ kind: 'add', text, newLine });
      if (newLine !== undefined) newLine += 1;
      continue;
    }
    if (text.startsWith('-')) {
      out.push({ kind: 'del', text, oldLine });
      if (oldLine !== undefined) oldLine += 1;
      continue;
    }
    out.push({ kind: 'context', text, oldLine, newLine });
    if (oldLine !== undefined) oldLine += 1;
    if (newLine !== undefined) newLine += 1;
  }
  return out;
}

/** 评论指向哪一侧、哪一行(在 hunk 之外无行号的行不可评论)。 */
export function commentTargetOf(line: ParsedDiffLine): { line: number; side: 'old' | 'new' } | undefined {
  if (line.kind === 'del' && line.oldLine !== undefined) return { line: line.oldLine, side: 'old' };
  if (line.kind !== 'del' && line.kind !== 'context' && line.kind !== 'add') return undefined;
  if (line.newLine !== undefined) return { line: line.newLine, side: 'new' };
  return undefined;
}

/** add/del/context 行的正文(剥掉 +/- 前缀)过 tokenize 上色;CJK 行不上色。 */
function HighlightedDiffText({ text, lang }: { text: string; lang: string }) {
  const prefix = text.slice(0, 1);
  const body = text.slice(1);
  const tokens = useMemo(() => (hasCjk(body) ? undefined : tokenize(body, lang)), [body, lang]);
  if (!tokens) return <span className="diff-text">{text || ' '}</span>;
  return (
    <span className="diff-text">
      {prefix}
      {tokens.map((token, i) =>
        token.kind === 'ws' ? (
          token.t
        ) : (
          <span key={i} className={`tok-${token.kind}`}>
            {token.t}
          </span>
        ),
      )}
    </span>
  );
}

export function DiffView({
  diff,
  showLineNumbers,
  onLineClick,
  highlight,
  showStat,
  hideMeta,
}: {
  diff: string;
  showLineNumbers?: boolean;
  onLineClick?: (line: ParsedDiffLine) => void;
  /** 语言标识(langOf 的产物):传入则 add/del/context 正文过 tokenize。 */
  highlight?: string;
  /** 顶部 +N −N 统计(默认显示);面板里文件条已给过统计,传 false 去重。 */
  showStat?: boolean;
  /** 隐藏补丁头(diff --git / index / ± 文件名行)。 */
  hideMeta?: boolean;
}) {
  const all = useMemo(() => parseDiffLines(diff), [diff]);
  const lines = hideMeta ? all.filter((line) => line.kind !== 'meta') : all;
  const adds = all.filter((line) => line.kind === 'add').length;
  const dels = all.filter((line) => line.kind === 'del').length;
  const commentable = onLineClick !== undefined;

  return (
    <div className="diff">
      {showStat !== false ? (
        <div className="diff-stat">
          <span className="diff-add">+{adds}</span> <span className="diff-del">−{dels}</span>
        </div>
      ) : null}
      <pre className="diff-body">
        {lines.map((line, index) => {
          const clickable = commentable && commentTargetOf(line) !== undefined;
          return (
            <div
              key={index}
              className={`diff-line diff-${line.kind} ${clickable ? 'diff-clickable' : ''}`}
              onClick={clickable ? () => onLineClick!(line) : undefined}
            >
              {showLineNumbers ? (
                <span className="diff-linenos">
                  <span className="diff-lineno">{line.oldLine ?? ''}</span>
                  <span className="diff-lineno">{line.newLine ?? ''}</span>
                </span>
              ) : null}
              {highlight && (line.kind === 'add' || line.kind === 'del' || line.kind === 'context') ? (
                <HighlightedDiffText text={line.text} lang={highlight} />
              ) : (
                <span className="diff-text">{line.text || ' '}</span>
              )}
              {clickable ? <span className="diff-comment-hint">💬</span> : null}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
