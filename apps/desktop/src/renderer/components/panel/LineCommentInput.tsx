/** 行下内嵌的评论输入(自 RightPanel.tsx 拆出;行评论能力保留自 Review 面板)。 */

import React, { useState } from 'react';
import { rpcFire } from '../../bridge/invoke.js';
import { useReviewStore } from '../../state/reviewStore.js';
import { t } from '../../i18n/index.js';
import { buildReviewComment } from '../../utils/review-comment.js';

export function LineCommentInput({ path }: { path: string }) {
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
    rpcFire({ kind: 'run', text, options: { display } }, { errorKey: 'notice.runFailed' });
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
