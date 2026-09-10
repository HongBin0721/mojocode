/**
 * 实时进度浮层卡(ZCode「进程 n/m」):挂在聊天列右上角,数据来自 state
 * 快照的 todos 字段(server 在每次 todo 变化时推送),与时间线里的历史
 * todo 条目(TimelineItemView 的 todo 分支)互补。可折叠成一行头部。
 */

import React, { useMemo, useState } from 'react';
import { TODO_STATE_KEY } from '@core/protocol';
import { useDesktopStore } from '../state/desktopStore.js';
import { parseTodos } from './TodoList.js';
import { useLocale, t } from '../i18n/index.js';
import { TodoList } from './TodoList.js';

export function TodoPanel() {
  useLocale();
  // 清单由 todo 扩展经 setState 发布;形状不对一律当没有(扩展没装、换了实现)。
  // selector 只取**原始引用**:parseTodos 是个 filter,每次调用都返回新数组,
  // 放进 selector 里就永远不等于上一次(store 用默认的 Object.is),于是每一帧
  // 状态推送都要重渲染整个面板——恰恰在流式输出、推送最密的时候。
  const raw = useDesktopStore((s) => s.snapshot?.extensions?.state?.[TODO_STATE_KEY]);
  const todos = useMemo(() => parseTodos(raw), [raw]);
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
