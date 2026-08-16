/**
 * todo 清单(todo 工具的输入携带完整列表;实时面板在 TodoPanel——数据
 * 来自 state 快照,不经时间线)。
 *
 * TodoItem 在此本地声明:根仓库的出处(src/tools/todo.ts)带 ai/zod 的
 * 运行时依赖,进不了 renderer;结构兼容(extractTodos 的返回值可直接喂)。
 */

import React from 'react';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <ul className="todo-list">
      {todos.map((todo, index) => (
        <li key={index} className={`todo-${todo.status}`}>
          <span className="todo-mark">
            {todo.status === 'completed' ? '✔' : todo.status === 'in_progress' ? '▶' : '·'}
          </span>
          <span className={todo.status === 'completed' ? 'todo-done' : ''}>{todo.content}</span>
        </li>
      ))}
    </ul>
  );
}
