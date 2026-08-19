/** 任务列表区(自 Sidebar.tsx 拆出):⌘K 搜索行(按需展开)+ 任务行/空态。 */

import React from 'react';
import type { TaskSummary } from '../../../shared/ipc.js';
import { t, useLocale } from '../../i18n/index.js';
import { TaskRow } from './TaskRow.js';

export function TaskList({
  tasks,
  list,
  activeId,
  pinned,
  searchOpen,
  query,
  onQueryChange,
  onCloseSearch,
  onContextMenu,
}: {
  /** 原始任务列表;undefined = tasks 通道降级(会话列表读取失败)。 */
  tasks: TaskSummary[] | undefined;
  /** 过滤/排序后的当前项目任务(口径在 utils/tasks.ts)。 */
  list: TaskSummary[];
  activeId: string | undefined;
  pinned: readonly string[];
  searchOpen: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onCloseSearch: () => void;
  onContextMenu: (task: TaskSummary, x: number, y: number) => void;
}) {
  useLocale();
  return (
    <>
      {searchOpen ? (
        <input
          className="task-search"
          value={query}
          placeholder={t('sidebar.search')}
          autoFocus
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCloseSearch();
          }}
        />
      ) : null}
      <div className="task-list">
        {tasks === undefined ? (
          <div className="sidebar-empty">{t('sidebar.unsupported')}</div>
        ) : list.length === 0 ? (
          <div className="sidebar-empty">{query ? t('sidebar.noMatch') : t('sidebar.noTasks')}</div>
        ) : (
          list.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              active={task.id === activeId}
              pinned={pinned.includes(task.id)}
              onContextMenu={onContextMenu}
            />
          ))
        )}
      </div>
    </>
  );
}
