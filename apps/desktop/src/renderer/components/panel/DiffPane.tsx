/** 变更 tab(自 RightPanel.tsx 拆出):文件条单选 + 单文件 diff + 批准栏。 */

import React, { useEffect } from 'react';
import { useReviewStore } from '../../state/reviewStore.js';
import { t, useLocale } from '../../i18n/index.js';
import { DiffView, commentTargetOf, type ParsedDiffLine } from '../DiffView.js';
import { langOf } from '../../utils/tokenize.js';
import { FileCodeIcon } from '../icons.js';
import { LineCommentInput } from './LineCommentInput.js';
import { DiffApprovalBar } from './DiffApprovalBar.js';

export function DiffPane() {
  useLocale();
  const status = useReviewStore((s) => s.status);
  const unsupported = useReviewStore((s) => s.unsupported);
  const selectedPath = useReviewStore((s) => s.selectedPath);
  const selectFile = useReviewStore((s) => s.selectFile);
  const diff = useReviewStore((s) => (s.selectedPath ? s.fileDiffs[s.selectedPath] : undefined));
  const loading = useReviewStore((s) =>
    s.selectedPath ? (s.loadingPaths[s.selectedPath] ?? false) : false,
  );
  const setCommentTarget = useReviewStore((s) => s.setCommentTarget);
  const approval = useReviewStore((s) => s.approval);

  // 首个文件自动选中(设计稿:进面板即见 diff)。
  useEffect(() => {
    if (!selectedPath && status?.ok && status.entries.length > 0) {
      selectFile(status.entries[0]!.path);
    }
  }, [selectedPath, status, selectFile]);

  const onLineClick = (line: ParsedDiffLine) => {
    if (!selectedPath) return;
    const target = commentTargetOf(line);
    if (!target) return;
    setCommentTarget({ path: selectedPath, line: target.line, side: target.side });
  };

  if (unsupported) return <div className="review-degraded">{t('review.unsupported')}</div>;
  if (!status) return <div className="review-loading">{t('review.loading')}</div>;
  if (!status.ok) return <div className="review-degraded">{t('review.fail.no-repo')}</div>;
  if (status.entries.length === 0 && approval !== 'committed') {
    return <div className="review-empty">{t('review.clean')}</div>;
  }

  return (
    <div className="diff-pane">
      <div className="diff-files">
        {status.entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className={`diff-file-row ${entry.path === selectedPath ? 'diff-file-active' : ''}`}
            onClick={() => selectFile(entry.path)}
          >
            <FileCodeIcon size={13} />
            <span className="diff-file-name" title={entry.path}>
              {entry.path}
            </span>
            {entry.additions !== undefined || entry.deletions !== undefined ? (
              <span className="review-stat">
                <span className="diff-add">+{entry.additions ?? 0}</span>{' '}
                <span className="diff-del">−{entry.deletions ?? 0}</span>
              </span>
            ) : null}
          </button>
        ))}
        {status.truncated ? <div className="review-degraded">{t('review.truncated')}</div> : null}
      </div>
      <div className="diff-scroll">
        {loading && !diff ? <div className="review-loading">{t('review.loading')}</div> : null}
        {diff?.ok && diff.diff !== undefined ? (
          <>
            <DiffView
              diff={diff.diff}
              showLineNumbers
              hideMeta
              showStat={false}
              onLineClick={onLineClick}
              highlight={langOf(selectedPath)}
            />
            {selectedPath ? <LineCommentInput path={selectedPath} /> : null}
          </>
        ) : null}
        {diff && !diff.ok ? (
          <div className="review-degraded">
            {t(`review.fail.${diff.reason ?? 'git-error'}` as 'review.fail.binary')}
          </div>
        ) : null}
      </div>
      <DiffApprovalBar />
    </div>
  );
}
