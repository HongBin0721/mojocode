/**
 * 工具卡片(设计稿形态):折叠头一行(工具图标 + mono label + meta + caret),
 * 展开是深底 detail 区——diff 走 DiffView,纯文本经 tokenize 近似高亮
 * (含 CJK 的行整行弱色,设计稿判据)。tokenize 按条目 useMemo,长输出
 * 只算一次。
 */

import React, { useMemo, useState } from 'react';
import { useLocale, t } from '../i18n/index.js';
import { formatDuration } from '../utils/format.js';
import { hasCjk, langOf, tokenize } from '../utils/tokenize.js';
import { DiffView } from './DiffView.js';
import {
  BrainIcon,
  CaretDownIcon,
  CaretUpIcon,
  FileCodeIcon,
  GlobeIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  RobotIcon,
  TerminalIcon,
} from './icons.js';

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

/** 工具名 → 图标(设计稿:每类工具一个 Phosphor 图标)。 */
function ToolIcon({ name }: { name: string }) {
  const size = 14;
  switch (name) {
    case 'bash':
      return <TerminalIcon size={size} />;
    case 'read':
    case 'write':
    case 'edit':
      return <FileCodeIcon size={size} />;
    case 'glob':
    case 'grep':
      return <MagnifyingGlassIcon size={size} />;
    case 'web_search':
    case 'web_fetch':
      return <GlobeIcon size={size} />;
    case 'todo':
      return <ListChecksIcon size={size} />;
    case 'task':
      return <RobotIcon size={size} />;
    default:
      return <BrainIcon size={size} />;
  }
}

/** detail 正文:逐行 tokenize 上色(CJK 行整行弱色)。 */
function HighlightedOutput({ text, path }: { text: string; path?: string }) {
  const lang = langOf(path);
  const lines = useMemo(() => {
    return text.split('\n').map((line) => (hasCjk(line) ? undefined : tokenize(line, lang)));
  }, [text, lang]);
  return (
    <div className="tool-output tool-output-code">
      {text.split('\n').map((line, index) => {
        const tokens = lines[index];
        if (!tokens) {
          return (
            <div key={index} className="tool-line tool-line-plain">
              {line || ' '}
            </div>
          );
        }
        return (
          <div key={index} className="tool-line">
            {tokens.map((token, i) =>
              token.kind === 'ws' ? (
                token.t
              ) : (
                <span key={i} className={`tok-${token.kind}`}>
                  {token.t}
                </span>
              ),
            )}
          </div>
        );
      })}
    </div>
  );
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
  const diff = diffText(output, isError);

  return (
    <div className={`tool-card ${isError ? 'tool-error' : ''}`}>
      <button type="button" className="tool-row" onClick={() => setExpanded(!expanded)}>
        <span className="tool-icon">
          <ToolIcon name={toolName} />
        </span>
        <span className="tool-name">{toolName}</span>
        {inputNote ? <span className="tool-input">{inputNote}</span> : null}
        <span className="tool-summary">{summary}</span>
        {durationMs > 1500 ? <span className="tool-duration">{formatDuration(durationMs)}</span> : null}
        <span className="tool-caret">{expanded ? <CaretUpIcon size={12} /> : <CaretDownIcon size={12} />}</span>
      </button>
      {expanded ? (
        diff !== undefined ? (
          <div className="tool-output">
            <DiffView diff={diff} showLineNumbers />
          </div>
        ) : (
          <HighlightedOutput text={describeOutput(output)} path={inputNote} />
        )
      ) : null}
      {isError && !expanded ? <div className="tool-error-line">{t('tool.failed')}</div> : null}
    </div>
  );
}
