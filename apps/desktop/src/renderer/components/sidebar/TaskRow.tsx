/** 任务行(自 Sidebar.tsx 拆出):TONE 状态点 + 标题,第二行 状态 · 相对时间。 */

import React, { memo } from 'react';
import type { TaskSummary } from '../../../shared/ipc.js';
import { openTask } from '../../state/actions.js';
import { taskTone, toneColorVar, toneLabelKey } from '../../utils/task-tone.js';
import { formatRelativeTime } from '../../utils/format.js';
import { t, useLocale } from '../../i18n/index.js';
import { PushPinIcon } from '../icons.js';

export const TaskRow = memo(function TaskRow({
  task,
  active,
  pinned,
  onContextMenu,
}: {
  task: TaskSummary;
  active: boolean;
  pinned: boolean;
  onContextMenu: (task: TaskSummary, x: number, y: number) => void;
}) {
  useLocale();
  const tone = taskTone(task);
  return (
    <button
      type="button"
      className={`task-row ${active ? 'task-row-active' : ''}`}
      onClick={() => openTask(task.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(task, e.clientX, e.clientY);
      }}
    >
      <span className="task-row-head">
        <span className="task-dot" style={{ background: toneColorVar(tone) }} />
        <span className="task-row-title">{task.title || task.id.slice(0, 8)}</span>
        {pinned ? (
          <span className="task-pin">
            <PushPinIcon size={11} />
          </span>
        ) : null}
        {task.hasPendingPermission ? <span className="task-badge-permission" /> : null}
      </span>
      <span className="task-row-meta">
        {t(toneLabelKey(tone))} · {formatRelativeTime(task.updatedAt)}
      </span>
    </button>
  );
});
