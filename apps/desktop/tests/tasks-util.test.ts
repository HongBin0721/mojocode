/**
 * utils/tasks.ts 的口径锁:空会话不进列表(聚焦中的也不例外)、归档过滤、
 * 搜索(标题包含/ID 前缀)、置顶前置且组内保持入参顺序。
 */

import { describe, expect, it } from 'vitest';
import type { TaskSummary } from '../src/shared/ipc.js';
import { archivedTasks, liveTasks, projectTasks } from '../src/renderer/utils/tasks.js';

function task(patch: Partial<TaskSummary> & { id: string }): TaskSummary {
  return {
    root: '/ws/a',
    provider: 'kimi',
    model: 'kimi-k3',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    title: patch.id,
    messageCount: 1,
    status: 'connected',
    isRunning: false,
    hasPendingPermission: false,
    unseen: false,
    ...patch,
  };
}

describe('liveTasks', () => {
  it('空会话(messageCount=0)与已归档不进列表;undefined 回空表', () => {
    const tasks = [
      task({ id: 'a' }),
      task({ id: 'empty', messageCount: 0 }),
      task({ id: 'archived', archivedAt: '2026-08-02T00:00:00Z' }),
    ];
    expect(liveTasks(tasks).map((t) => t.id)).toEqual(['a']);
    expect(liveTasks(undefined)).toEqual([]);
  });
});

describe('projectTasks', () => {
  const live = [
    task({ id: 'aaa-1', title: 'fix login' }),
    task({ id: 'bbb-2', title: 'refactor menu' }),
    task({ id: 'ccc-3', title: 'login page' }),
    task({ id: 'ddd-4', title: 'other root', root: '/ws/b' }),
  ];

  it('root 过滤 + 标题包含/ID 前缀搜索(大小写不敏感)', () => {
    expect(projectTasks(live, '/ws/a', '', []).map((t) => t.id)).toEqual([
      'aaa-1',
      'bbb-2',
      'ccc-3',
    ]);
    expect(projectTasks(live, '/ws/a', 'LOGIN', []).map((t) => t.id)).toEqual(['aaa-1', 'ccc-3']);
    expect(projectTasks(live, '/ws/a', 'bbb', []).map((t) => t.id)).toEqual(['bbb-2']);
    expect(projectTasks(live, undefined, '', [])).toEqual([]);
  });

  it('置顶前置,置顶内与未置顶内都保持入参顺序(稳定)', () => {
    expect(projectTasks(live, '/ws/a', '', ['ccc-3']).map((t) => t.id)).toEqual([
      'ccc-3',
      'aaa-1',
      'bbb-2',
    ]);
  });
});

describe('archivedTasks', () => {
  it('只留 archivedAt 非空,按归档时间倒序', () => {
    const tasks = [
      task({ id: 'live' }),
      task({ id: 'old', archivedAt: '2026-08-01T00:00:00Z' }),
      task({ id: 'new', archivedAt: '2026-08-03T00:00:00Z' }),
    ];
    expect(archivedTasks(tasks).map((t) => t.id)).toEqual(['new', 'old']);
  });
});
