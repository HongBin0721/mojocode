/**
 * 工具卡片(设计稿形态):折叠头一行(工具图标 + mono label + meta + caret),
 * 展开是深底 detail 区——diff 走 DiffView,纯文本经 tokenize 近似高亮
 * (含 CJK 的行整行弱色,设计稿判据)。tokenize 按条目 useMemo,长输出
 * 只算一次。大内容出流:diff 卡可跳右侧评审面板、bash 可跳终端面板。
 */

import React, { useMemo, useState } from 'react';
import { extractOutputText, toolDisplayName } from '@core/timeline-data';
import { useLocale, t, type MessageKey } from '../i18n/index.js';
import { formatDuration } from '../utils/format.js';
import { hasCjk, langOf, tokenize } from '../utils/tokenize.js';
import { useDesktopStore } from '../state/desktopStore.js';
import { usePanelStore } from '../state/panelStore.js';
import { useReviewStore } from '../state/reviewStore.js';
import { useUiStore } from '../state/uiStore.js';
import { DiffView, countDiff, parseDiffLines } from './DiffView.js';
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

/** 头行耗时的显示阈值(ExploreGroup 同用):快操作不值得占一段 meta。 */
export const DURATION_SHOW_MS = 1500;

/**
 * renderDiff 的截断标记(src/tools/context.ts 的 truncate 产出;那是 Node 侧
 * 模块,renderer 引不了,只能字面量对齐——上游改文案这里要跟)。截断的
 * diff 统计只是下限,渲染时数字后缀 +。
 */
export const TRUNCATED_MARK = '… output truncated (';

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

/** 展开区底部的跳转行(评审面板 / 终端面板共用同一形态)。 */
function JumpRow({ label, onClick }: { label: MessageKey; onClick: () => void }) {
  return (
    <div className="tool-jump-row">
      <button type="button" className="tool-jump" onClick={onClick}>
        {t(label)}
      </button>
    </div>
  );
}

/**
 * bash 的终端跳转。独立成组件是为了把 desktopStore/panelStore 的订阅关在
 * 「展开中的 bash 卡」里——挂在 ToolCard 上会让全历史工具卡都吃切任务/
 * 输出流式的 selector 开销。终端面板只吃实时 tool-output-delta:回放/
 * 休眠复活的会话里它是空的,这时不给「在终端查看」的承诺。
 */
function TerminalJump() {
  const focusedTaskId = useDesktopStore((s) => s.focusedTaskId);
  const hasTerminal = usePanelStore((s) =>
    focusedTaskId !== undefined ? (s.terminals[focusedTaskId]?.lines.length ?? 0) > 0 : false,
  );
  if (!hasTerminal) return null;
  return (
    <JumpRow
      label="tool.openInTerminal"
      onClick={() => {
        // 面板可能被 × 关掉了(持久化):只切 tab 不现身等于按钮无效。
        useReviewStore.getState().setVisible(true);
        useUiStore.getState().setRightTab('terminal');
      }}
    />
  );
}

export function ToolCard({
  toolName,
  input,
  summary,
  output,
  isError,
  durationMs,
  thoughtMs,
  thoughtText,
}: {
  toolName: string;
  input: unknown;
  summary: string;
  output: unknown;
  isError: boolean;
  durationMs: number;
  /** 并进来的「微思考」:时长进 meta,原文挂 title 悬停可见。 */
  thoughtMs?: number;
  thoughtText?: string;
}) {
  useLocale();
  const [expanded, setExpanded] = useState(false);
  // diff 工具的输入里 path 是最有信息量的一段;截断到一行。
  const inputNote =
    input && typeof input === 'object' && 'path' in (input as Record<string, unknown>)
      ? String((input as Record<string, unknown>).path)
      : undefined;
  const diff = diffText(output, isError);
  const stat = useMemo(
    () =>
      diff !== undefined
        ? { ...countDiff(parseDiffLines(diff)), truncated: diff.includes(TRUNCATED_MARK) }
        : undefined,
    [diff],
  );
  // 非字符串 output 的 JSON 序列化可能是几十 KB 级:只在展开时算,且缓存。
  const outputText = useMemo(
    () => (expanded && diff === undefined ? extractOutputText(toolName, output) : ''),
    [expanded, diff, toolName, output],
  );

  const openDiffPane = () => {
    // 工具路径以工作区为基准(output.path 是归一化的相对路径,input.path
    // 可能是绝对路径),评审面板以 git 仓库顶层为基准——工作区在仓库子目录
    // 时两者不同。按后缀匹配挑 status entry;匹配不到只开面板不选文件
    // (硬塞会命中 invalid-path/not-found 错误卡,面板自己会选中首个文件)。
    const fromOutput = (output as { path?: unknown } | undefined)?.path;
    const toolPath = typeof fromOutput === 'string' ? fromOutput : inputNote;
    const { status, selectFile, setVisible } = useReviewStore.getState();
    if (toolPath && status?.ok) {
      const match = status.entries.find(
        (entry) =>
          entry.path === toolPath ||
          entry.path.endsWith(`/${toolPath}`) ||
          toolPath.endsWith(`/${entry.path}`),
      );
      if (match) selectFile(match.path);
    }
    // 面板可能被 × 关掉了(持久化):只切 tab 不现身等于按钮无效。
    setVisible(true);
    useUiStore.getState().setRightTab('diff');
  };

  const more = stat?.truncated ? '+' : '';

  return (
    <div className={`tool-card ${isError ? 'tool-error' : ''}`}>
      <button type="button" className="tool-row" onClick={() => setExpanded(!expanded)}>
        <span className="tool-icon">
          <ToolIcon name={toolName} />
        </span>
        <span className="tool-name">{toolDisplayName(toolName)}</span>
        {inputNote ? <span className="tool-input">{inputNote}</span> : null}
        {stat ? (
          <span className="tool-diffstat">
            <span className="diff-add">
              +{stat.additions}
              {more}
            </span>
            <span className="diff-del">
              −{stat.deletions}
              {more}
            </span>
          </span>
        ) : null}
        <span className="tool-summary">{summary}</span>
        {thoughtMs !== undefined || thoughtText !== undefined ? (
          <span className="tool-thought" title={thoughtText}>
            <BrainIcon size={11} />
            {thoughtMs !== undefined
              ? t('reasoning.chip', { duration: formatDuration(thoughtMs) })
              : t('reasoning.chipBare')}
          </span>
        ) : null}
        {durationMs > DURATION_SHOW_MS ? (
          <span className="tool-duration">{formatDuration(durationMs)}</span>
        ) : null}
        <span className="tool-caret">{expanded ? <CaretUpIcon size={12} /> : <CaretDownIcon size={12} />}</span>
      </button>
      {expanded ? (
        <>
          {diff !== undefined ? (
            <div className="tool-output">
              <DiffView diff={diff} showLineNumbers />
            </div>
          ) : (
            <HighlightedOutput text={outputText} path={inputNote} />
          )}
          {/* 大内容出流:该内容有专门面板的,给一条跳转(评审面板看当前
              工作区 diff,终端面板存有 bash 的完整流式输出)。 */}
          {diff !== undefined ? (
            <JumpRow label="tool.openInDiff" onClick={openDiffPane} />
          ) : toolName === 'bash' ? (
            <TerminalJump />
          ) : null}
        </>
      ) : null}
      {isError && !expanded ? <div className="tool-error-line">{t('tool.failed')}</div> : null}
    </div>
  );
}
