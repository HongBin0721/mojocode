/**
 * 实时 todo 面板:数据来自 state 快照的 todos 字段(server 在每次 todo 变化
 * 时推送),与时间线里的历史 todo 条目(TimelineItemView 的 todo 分支)互补。
 */

import React from 'react';
import { useDesktopStore } from '../state/desktopStore.js';
import { useLocale, t } from '../i18n/index.js';
import { TodoList } from './TodoList.js';

export function TodoPanel() {
  useLocale();
  const todos = useDesktopStore((s) => s.snapshot?.todos);
  if (!todos || todos.length === 0) return null;
  return (
    <div className="todo-panel">
      <div className="todo-panel-title">{t('todo.title')}</div>
      <TodoList todos={todos} />
    </div>
  );
}
