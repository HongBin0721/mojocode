/**
 * todo 清单(todo 工具的输入携带完整列表;实时面板在 TodoPanel——数据
 * 来自 state 快照,不经时间线)。
 *
 * TodoItem 与 parseTodos 从 `@core/timeline-data` 取——它是 Node-free 的
 * renderer 白名单入口,todo 扩展自己也是反过来从它 import 的。这里曾有一份
 * 逐字相同的副本,理由是"出处(todo 扩展)带 ai/zod";parseTodos 搬进
 * timeline-data 之后那条理由不再成立,而两份形状判定漂移时 typecheck 看不
 * 出来,GUI 只会安静地把整份清单判成 undefined、面板空掉。
 */

import React from 'react';
import { parseTodos, type TodoItem } from '@core/timeline-data';

export { parseTodos, type TodoItem };

export function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <ul className="todo-list">
      {todos.map((todo, index) => (
        <li key={index} className={`todo-${todo.status}`}>
          {/* ZCode 形态:圆环勾选标记(完成=绿圈勾,进行中=琥珀点,待办=灰圈) */}
          <span className="todo-ring" aria-hidden>
            {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : ''}
          </span>
          <span className={todo.status === 'completed' ? 'todo-done' : ''}>{todo.content}</span>
        </li>
      ))}
    </ul>
  );
}
