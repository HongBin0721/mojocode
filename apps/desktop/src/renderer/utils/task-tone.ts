/**
 * 任务状态色(设计稿 TONE):任务行状态点、任务头 tag、首页卡片共用的
 * 纯推导。优先级:运行中 > 有待落地变更(待审查)> 空会话(草稿)> 完成。
 */

import type { TaskSummary } from '../../shared/ipc.js';

export type TaskTone = 'run' | 'review' | 'draft' | 'done';

export function taskTone(task: TaskSummary, changedFileCount?: number): TaskTone {
  if (task.isRunning) return 'run';
  if ((changedFileCount ?? 0) > 0) return 'review';
  if (task.messageCount === 0) return 'draft';
  return 'done';
}

/** 状态点的 CSS 变量名(tokens.less 的 --tone-*)。 */
export function toneColorVar(tone: TaskTone): string {
  return `var(--tone-${tone})`;
}

/** 状态 tag 的 i18n key(task.status.* 命名空间)。 */
export function toneLabelKey(tone: TaskTone): `task.status.${TaskTone}` {
  return `task.status.${tone}`;
}
