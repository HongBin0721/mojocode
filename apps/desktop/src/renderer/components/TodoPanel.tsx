/**
 * 实时进度浮层卡(ZCode「进程 n/m」):挂在聊天列右上角,数据来自 state
 * 快照的 todos 字段(server 在每次 todo 变化时推送),与时间线里的历史
 * todo 条目(TimelineItemView 的 todo 分支)互补。可折叠成一行头部。
 */

import React, { useState } from 'react';
import { useDesktopStore } from '../state/desktopStore.js';
import { useLocale, t } from '../i18n/index.js';
import { TodoList } from './TodoList.js';

export function TodoPanel() {
  useLocale();
  const todos = useDesktopStore((s) => s.snapshot?.todos);
  const [collapsed, setCollapsed] = useState(false);
  if (!todos || todos.length === 0) return null;
  const done = todos.reduce((n, todo) => n + (todo.status === 'completed' ? 1 : 0), 0);
  return (
    <div className="todo-float">
      <div className="todo-float-head">
        <span className="todo-float-title">{t('todo.title')}</span>
        <span className="todo-float-count">
          {done}/{todos.length}
        </span>
        <button type="button" className="todo-float-toggle" onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? '⌄' : '⌃'}
        </button>
      </div>
      {!collapsed ? <TodoList todos={todos} /> : null}
    </div>
  );
}
