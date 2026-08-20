/**
 * 任务行(项目树内嵌,设计稿单行):运行中 = 旋转图标(强调色)+「运行中」
 * meta;空闲且 unseen = TONE 状态点(绿点 = 跑完了还没打开看)。unseen 由
 * main 的 TaskManager 计算并随 tasks 通道下发(已看表持久化在 gui.json,
 * 与会话 1:1)——renderer 不持有 viewed 状态,聚焦行只做本地即时熄灭。
 */

import React, { memo } from 'react';
import type { TaskSummary } from '../../../shared/ipc.js';
import { openTask } from '../../state/actions.js';
import { taskTone, toneColorVar } from '../../utils/task-tone.js';
import { formatRelativeTime } from '../../utils/format.js';
import { t, useLocale } from '../../i18n/index.js';
import { CircleNotchIcon, PushPinIcon } from '../icons.js';

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
  // active 兜底:聚焦切换的已看标记要走一次 main 往返,聚焦行先本地熄灭。
  // 运行分支在渲染里已优先(旋转图标),unseen 又由 main 保证运行中恒 false。
  const showDot = task.unseen && !active;
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
      {task.isRunning ? (
        <span className="task-row-spin">
          <CircleNotchIcon size={11} />
        </span>
      ) : showDot ? (
        <span className="task-dot" style={{ background: toneColorVar(taskTone(task)) }} />
      ) : null}
      <span className="task-row-title">{task.title || task.id.slice(0, 8)}</span>
      {pinned ? (
        <span className="task-pin">
          <PushPinIcon size={11} />
        </span>
      ) : null}
      {task.hasPendingPermission ? <span className="task-badge-permission" /> : null}
      {task.isRunning ? (
        <span className="task-row-when task-row-when-running">{t('task.status.run')}</span>
      ) : (
        <span className="task-row-when">{formatRelativeTime(task.updatedAt)}</span>
      )}
    </button>
  );
});
