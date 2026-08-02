import { describe, expect, it } from 'vitest';
import { MAX_TODO_ROWS, todoPanelRows } from '../src/ui/TodoPanel.js';
import type { TodoItem } from '../src/tools/todo.js';

const make = (n: number, status: TodoItem['status']): TodoItem[] =>
  Array.from({ length: n }, (_, i) => ({ content: `task-${status}-${i}`, status }));

describe('todoPanelRows', () => {
  it('短清单原样全部展示', () => {
    const todos = [...make(2, 'completed'), ...make(1, 'in_progress'), ...make(3, 'pending')];
    const rows = todoPanelRows(todos);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.kind === 'todo')).toBe(true);
  });

  it('超长清单折叠已完成项并截断尾部,总行数不超过上限', () => {
    const todos = [...make(3, 'completed'), ...make(1, 'in_progress'), ...make(6, 'pending')];
    const rows = todoPanelRows(todos);
    expect(rows.length).toBeLessThanOrEqual(MAX_TODO_ROWS);
    expect(rows[0]).toEqual({ kind: 'done-collapsed', n: 3 });
    expect(rows.at(-1)).toEqual({ kind: 'overflow', n: 3 });
  });

  it('进行中的任务排在待办之前,截断时不会被挤掉', () => {
    // 关键用例:in_progress 排在一长串 pending *之后*。按位置截断的实现
    // 会把它砍掉,面板就再也看不出"当前在做什么"。
    const running = { content: 'running-task', status: 'in_progress' as const };
    const rows = todoPanelRows([...make(8, 'pending'), running]);
    expect(rows.length).toBeLessThanOrEqual(MAX_TODO_ROWS);
    expect(rows[0]).toEqual({ kind: 'todo', todo: running });
  });

  it('已折叠已完成项时,进行中的任务同样优先', () => {
    const running = { content: 'running-task', status: 'in_progress' as const };
    const rows = todoPanelRows([...make(2, 'completed'), ...make(8, 'pending'), running]);
    expect(rows[0]).toEqual({ kind: 'done-collapsed', n: 2 });
    expect(rows[1]).toEqual({ kind: 'todo', todo: running });
  });

  it('没有已完成项时只折叠尾部', () => {
    const rows = todoPanelRows(make(10, 'pending'));
    expect(rows).toHaveLength(MAX_TODO_ROWS);
    expect(rows[0]?.kind).toBe('todo');
    expect(rows.at(-1)).toEqual({ kind: 'overflow', n: 5 });
  });

  it('未完成项极少时不需要尾部截断', () => {
    const todos = [...make(8, 'completed'), ...make(1, 'in_progress')];
    const rows = todoPanelRows(todos);
    expect(rows).toEqual([
      { kind: 'done-collapsed', n: 8 },
      { kind: 'todo', todo: todos[8] },
    ]);
  });
});
