/**
 * unified diff 视图:解析 @@ hunk 头推进行号(old/new 双列),增/删/上下文
 * 语义着色。两种用法:纯查看(timeline 工具卡、权限卡——不传回调)与
 * Review 面板(传 onLineClick 启用行评论)。文本经 React 转义,无注入面。
 */

import React, { useMemo } from 'react';

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
    if (text.startsWith('+++') || text.startsWith('---')) {
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

export function DiffView({
  diff,
  showLineNumbers,
  onLineClick,
}: {
  diff: string;
  showLineNumbers?: boolean;
  onLineClick?: (line: ParsedDiffLine) => void;
}) {
  const lines = useMemo(() => parseDiffLines(diff), [diff]);
  const adds = lines.filter((line) => line.kind === 'add').length;
  const dels = lines.filter((line) => line.kind === 'del').length;
  const commentable = onLineClick !== undefined;

  return (
    <div className="diff">
      <div className="diff-stat">
        <span className="diff-add">+{adds}</span> <span className="diff-del">−{dels}</span>
      </div>
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
              <span className="diff-text">{line.text || ' '}</span>
              {clickable ? <span className="diff-comment-hint">💬</span> : null}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
