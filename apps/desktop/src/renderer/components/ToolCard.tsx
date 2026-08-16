/**
 * 工具卡片:折叠态一行(工具名 + summary + 耗时),展开看完整输出。
 * diff 类输出(output.diff / permission detail)在 M3 换成 DiffView 语法
 * 高亮;当前先按纯文本/JSON 展示。
 */

import React, { useState } from 'react';
import { useLocale, t } from '../i18n/index.js';
import { formatDuration } from '../utils/format.js';
import { DiffView } from './DiffView.js';

function describeOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2) ?? '';
  } catch {
    return String(output);
  }
}

/** write/edit 的 diff 落在 output.diff(展开态走 DiffView,带行号)。 */
function diffText(output: unknown, isError: boolean): string | undefined {
  if (isError) return undefined;
  const diff = (output as { diff?: unknown } | undefined)?.diff;
  return typeof diff === 'string' ? diff : undefined;
}

export function ToolCard({
  toolName,
  input,
  summary,
  output,
  isError,
  durationMs,
}: {
  toolName: string;
  input: unknown;
  summary: string;
  output: unknown;
  isError: boolean;
  durationMs: number;
}) {
  useLocale();
  const [expanded, setExpanded] = useState(false);
  // diff 工具的输入里 path 是最有信息量的一段;截断到一行。
  const inputNote =
    input && typeof input === 'object' && 'path' in (input as Record<string, unknown>)
      ? String((input as Record<string, unknown>).path)
      : undefined;

  return (
    <div className={`tool-card ${isError ? 'tool-error' : ''}`}>
      <button type="button" className="tool-row" onClick={() => setExpanded(!expanded)}>
        <span className="tool-name">{toolName}</span>
        {inputNote ? <span className="tool-input">{inputNote}</span> : null}
        <span className="tool-summary">{summary}</span>
        {durationMs > 1500 ? <span className="tool-duration">{formatDuration(durationMs)}</span> : null}
        <span className="reasoning-arrow">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded ? (
        diffText(output, isError) !== undefined ? (
          <div className="tool-output">
            <DiffView diff={diffText(output, isError)!} showLineNumbers />
          </div>
        ) : (
          <pre className="tool-output">{describeOutput(output)}</pre>
        )
      ) : null}
      {isError && !expanded ? <div className="tool-error-line">{t('tool.failed')}</div> : null}
    </div>
  );
}
