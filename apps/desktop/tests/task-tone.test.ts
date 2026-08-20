/**
 * taskTone 状态推导:运行中 > 待审查(有变更)> 草稿(空会话)> 完成。
 */

import { describe, expect, it } from 'vitest';
import { taskTone, toneColorVar, toneLabelKey } from '../src/renderer/utils/task-tone.js';
import type { TaskSummary } from '../src/shared/ipc.js';

const base: TaskSummary = {
  id: 's-1',
  root: '/w',
  provider: 'kimi',
  model: 'm',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  title: 't',
  messageCount: 4,
  status: 'connected',
  isRunning: false,
  hasPendingPermission: false,
  unseen: false,
};

describe('taskTone', () => {
  it.each([
    [{ ...base, isRunning: true }, 3, 'run'],
    [{ ...base }, 3, 'review'],
    [{ ...base, messageCount: 0 }, 0, 'draft'],
    [{ ...base }, 0, 'done'],
  ] as const)('推导 %#', (task, changed, expected) => {
    expect(taskTone(task, changed)).toBe(expected);
  });

  it('运行中压过变更;缺省变更数按 0', () => {
    expect(taskTone({ ...base, isRunning: true }, 9)).toBe('run');
    expect(taskTone(base)).toBe('done');
  });

  it('色变量与 i18n key 命名', () => {
    expect(toneColorVar('review')).toBe('var(--tone-review)');
    expect(toneLabelKey('draft')).toBe('task.status.draft');
  });
});
