/**
 * 代码评审面板(Codex 的 Code Review Panel):pending 变更文件列表
 * (git status)→ 点击展开按需加载 unified diff(带行号)→ 点击行评论
 * (转 run RPC,运行中由 server 注入当前轮)。`Cmd/Ctrl+Option+B` 切换显隐;
 * 三种降级:非 git 仓库 / server 过旧 / 干净树。
 *
 * 内含 ReviewFileRow 与 LineCommentInput(同文件收拢:三者只在本面板内使用)。
 */

import React, { useEffect, useRef, useState } from 'react';
import type { WorkspaceFileEntrySummary } from '../../shared/ipc.js';
import { useReviewStore } from '../state/reviewStore.js';
import { t, useLocale } from '../i18n/index.js';
import { DiffView, commentTargetOf, type ParsedDiffLine } from './DiffView.js';
import { buildReviewComment } from '../utils/review-comment.js';

const CHANGE_LABEL: Record<WorkspaceFileEntrySummary['change'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
};

/** 行下内嵌的评论输入。 */
function LineCommentInput({ path }: { path: string }) {
  const setCommentTarget = useReviewStore((s) => s.setCommentTarget);
  const target = useReviewStore((s) => s.commentTarget);
  const [value, setValue] = useState('');
  if (!target || target.path !== path) return null;

  const submit = () => {
    const comment = value.trim();
    if (!comment) return;
    const { text, display } = buildReviewComment({
      path: target.path,
      line: target.line,
      side: target.side,
      comment,
    });
    setValue('');
    setCommentTarget(undefined);
    // 统一走 run:运行中由 server 转 inject,空闲起新轮(loop.ts 的快速路径)。
    void window.mojocode
      .rpc({ kind: 'run', text, options: { display } })
      .catch((error: unknown) => console.error('评论发送失败', error));
  };

  return (
    <div className="line-comment">
      <input
        autoFocus
        value={value}
        placeholder={t('review.commentPlaceholder', { line: target.line })}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape') setCommentTarget(undefined);
        }}
      />
      <button type="button" className="btn-primary" disabled={!value.trim()} onClick={submit}>
        {t('review.commentSend')}
      </button>
      <button type="button" onClick={() => setCommentTarget(undefined)}>
        {t('review.commentCancel')}
      </button>
    </div>
  );
}

/** 单个文件卡:折叠态一行(变更标记 + 路径 + ±),展开态 diff + 行评论。 */
function ReviewFileRow({ entry }: { entry: WorkspaceFileEntrySummary }) {
  useLocale();
  const expanded = useReviewStore((s) => s.expandedPaths.includes(entry.path));
  const diff = useReviewStore((s) => s.fileDiffs[entry.path]);
  const loading = useReviewStore((s) => s.loadingPaths[entry.path] ?? false);
  const setCommentTarget = useReviewStore((s) => s.setCommentTarget);
  const toggleFile = useReviewStore((s) => s.toggleFile);

  const onLineClick = (line: ParsedDiffLine) => {
    const target = commentTargetOf(line);
    if (!target) return;
    setCommentTarget({ path: entry.path, line: target.line, side: target.side });
  };

  return (
    <div className={`review-file ${expanded ? 'review-file-open' : ''}`}>
      <button type="button" className="review-file-row" onClick={() => toggleFile(entry.path)}>
        <span className={`review-change review-change-${entry.change}`}>{CHANGE_LABEL[entry.change]}</span>
        <span className="review-path" title={entry.renameFrom ? `${entry.renameFrom} → ${entry.path}` : entry.path}>
          {entry.path}
        </span>
        {entry.additions !== undefined || entry.deletions !== undefined ? (
          <span className="review-stat">
            <span className="diff-add">+{entry.additions ?? 0}</span>{' '}
            <span className="diff-del">−{entry.deletions ?? 0}</span>
          </span>
        ) : null}
        <span className="reasoning-arrow">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded ? (
        <div className="review-file-body">
          {loading && !diff ? <div className="review-loading">{t('review.loading')}</div> : null}
          {diff?.ok && diff.diff !== undefined ? (
            <>
              <DiffView diff={diff.diff} showLineNumbers onLineClick={onLineClick} />
              <LineCommentInput path={entry.path} />
            </>
          ) : null}
          {diff && !diff.ok ? (
            <div className="review-degraded">{t(`review.fail.${diff.reason ?? 'git-error'}` as 'review.fail.binary')}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 拖宽分隔条:拖动改 flex-basis(220–720px)。 */
function Resizer({ onDrag }: { onDrag: (deltaX: number) => void }) {
  const lastX = useRef(0);
  return (
    <div
      className="review-resizer"
      onMouseDown={(e) => {
        lastX.current = e.clientX;
        const move = (ev: MouseEvent) => {
          onDrag(ev.clientX - lastX.current);
          lastX.current = ev.clientX;
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.style.cursor = '';
        };
        document.body.style.cursor = 'col-resize';
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      }}
    />
  );
}

export function ReviewPanel() {
  useLocale();
  const visible = useReviewStore((s) => s.visible);
  const status = useReviewStore((s) => s.status);
  const unsupported = useReviewStore((s) => s.unsupported);
  const toggleVisible = useReviewStore((s) => s.toggleVisible);
  const refresh = useReviewStore((s) => s.refresh);
  const [width, setWidth] = useState(480);

  // Cmd/Ctrl+Option+B 切换(文档级监听,textarea 之外也能触发)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggleVisible();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleVisible]);

  // 窗口 focus 时刷新(pending 变更可能在 GUI 之外发生)。
  useEffect(() => {
    const onFocus = () => {
      if (useReviewStore.getState().visible) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  // 挂载即拉一次:visible 从 localStorage 恢复(应用启动)不经过 setVisible
  // 的刷新路径,首屏要自己补。
  useEffect(() => {
    const { visible: shown, status, unsupported } = useReviewStore.getState();
    if (shown && status === undefined && !unsupported) void refresh();
  }, [refresh]);

  if (!visible) return null;

  return (
    <div className="review-panel" style={{ flexBasis: `${width}px` }}>
      <Resizer onDrag={(delta) => setWidth((w) => Math.min(720, Math.max(240, w - delta)))} />
      <div className="review-header">
        <span className="review-title">{t('review.title')}</span>
        {status?.ok ? (
          <span className="review-totals">
            <span className="diff-add">+{status.additions}</span>{' '}
            <span className="diff-del">−{status.deletions}</span>
            {status.branch ? <span className="review-branch">{status.branch}</span> : null}
          </span>
        ) : null}
        <span className="toolbar-spacer" />
        <button type="button" className="review-icon" title={t('review.refresh')} onClick={() => void refresh()}>
          ⟳
        </button>
        <button type="button" className="review-icon" title={t('review.close')} onClick={toggleVisible}>
          ×
        </button>
      </div>
      <div className="review-body">
        {unsupported ? (
          <div className="review-degraded">{t('review.unsupported')}</div>
        ) : !status ? (
          <div className="review-loading">{t('review.loading')}</div>
        ) : !status.ok ? (
          <div className="review-degraded">{t('review.fail.no-repo')}</div>
        ) : status.entries.length === 0 ? (
          <div className="review-empty">{t('review.clean')}</div>
        ) : (
          <>
            {status.entries.map((entry) => (
              <ReviewFileRow key={entry.path} entry={entry} />
            ))}
            {status.truncated ? <div className="review-degraded">{t('review.truncated')}</div> : null}
          </>
        )}
      </div>
    </div>
  );
}
