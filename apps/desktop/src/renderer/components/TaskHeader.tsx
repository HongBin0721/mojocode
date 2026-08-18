/**
 * 任务头(设计稿):标题 + meta 行(分支 mono · 变更统计),右侧状态 tag。
 * 纯展示——窗口拖拽区已归 TitleBar。选择器全部收窄为标量:这条栏随每个
 * bus 事件收 state 推送,订阅整份 snapshot 会把流式轮次变成持续重渲染。
 */

import React, { useEffect } from 'react';
import { useDesktopStore } from '../state/desktopStore.js';
import { useReviewStore } from '../state/reviewStore.js';
import { taskTone, toneColorVar, toneLabelKey } from '../utils/task-tone.js';
import { t, useLocale } from '../i18n/index.js';

export function TaskHeader() {
  useLocale();
  const root = useDesktopStore((s) => s.snapshot?.root);
  const storeId = useDesktopStore((s) => s.snapshot?.storeId);
  const title = useDesktopStore((s) => {
    const id = s.snapshot?.storeId;
    return (id && s.tasks?.find((task) => task.id === id)?.title) || undefined;
  });
  const focusedTask = useDesktopStore((s) =>
    s.tasks?.find((task) => task.id === s.snapshot?.storeId),
  );
  const changedCount = useDesktopStore((s) => s.snapshot?.changedFiles?.length ?? 0);
  const branch = useReviewStore((s) => (s.status?.ok ? s.status.branch : undefined));
  const additions = useReviewStore((s) => s.status?.additions ?? 0);
  const deletions = useReviewStore((s) => s.status?.deletions ?? 0);
  const entryCount = useReviewStore((s) => s.status?.entries.length ?? 0);
  const unsupported = useReviewStore((s) => s.unsupported);
  const refresh = useReviewStore((s) => s.refresh);

  useEffect(() => {
    if (root && !unsupported) void refresh();
  }, [root, unsupported, refresh]);

  if (root === undefined || storeId === undefined) return null;

  const tone = focusedTask ? taskTone(focusedTask, changedCount) : undefined;
  const meta =
    entryCount > 0
      ? t('taskHeader.changes', {
          files: String(entryCount),
          add: String(additions),
          del: String(deletions),
        })
      : t('taskHeader.noChanges');

  return (
    <div className="task-header">
      <div className="task-header-main">
        <div className="task-header-title">{title ?? t('topbar.newTask')}</div>
        <div className="task-header-meta">
          {branch ? <span className="task-header-branch">{branch}</span> : null}
          {branch ? ' · ' : ''}
          {meta}
        </div>
      </div>
      {tone ? (
        <span className="task-header-tag">
          <span className="task-dot" style={{ background: toneColorVar(tone) }} />
          {t(toneLabelKey(tone))}
        </span>
      ) : null}
    </div>
  );
}
