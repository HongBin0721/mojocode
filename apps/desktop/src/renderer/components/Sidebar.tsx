/**
 * 侧栏(Codex 设计稿形态,252px 起可拖宽)——外壳:store 订阅、当前项目
 * 决议与布局组装;子件在 sidebar/ 子目录(ProjectSwitcher / TaskList /
 * TaskRow / SidebarResizer / RenameDialog / use-task-context-menu)。
 *
 * 结构:1. 项目切换器;2. 全宽「+ 新建任务」;3. 主导航(首页/任务/归档);
 * 4. 「任务」分组(⌘K 搜索 + 任务行 + 右键菜单);5. 底部设置入口。
 * 右缘可拖宽(264~50vw,双击复位),⌘B 折叠(App 里监听;折叠态的展开钮
 * 在 TitleBar)。窗口拖拽区归 TitleBar,侧栏不再承担。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useDesktopStore } from '../state/desktopStore.js';
import { useUiStore, type View } from '../state/uiStore.js';
import { useProjectsStore } from '../state/projectsStore.js';
import { newTask } from '../state/actions.js';
import { archivedTasks, liveTasks, projectTasks, taskCountsByRoot } from '../utils/tasks.js';
import { t, useLocale } from '../i18n/index.js';
import { ImportProjectDialog } from './ImportProjectDialog.js';
import { ProjectSwitcher } from './sidebar/ProjectSwitcher.js';
import { SidebarResizer } from './sidebar/SidebarResizer.js';
import { TaskList } from './sidebar/TaskList.js';
import { useTaskContextMenu } from './sidebar/use-task-context-menu.js';
import {
  ArchiveIcon,
  ChatTeardropDotsIcon,
  GearIcon,
  HouseIcon,
  PlusIcon,
} from './icons.js';

export function Sidebar() {
  useLocale();
  const tasks = useDesktopStore((s) => s.tasks);
  // 窄选择器:Sidebar 随每个 bus 事件收 state 推送,订阅整份 snapshot 会把
  // 流式轮次里的几十次推送全变成全树重渲染。
  const storeId = useDesktopStore((s) => s.snapshot?.storeId);
  const running = useDesktopStore((s) => s.snapshot?.agent.isRunning ?? false);
  const focusedRoot = useDesktopStore((s) => s.snapshot?.root);
  const view = useUiStore((s) => s.view);
  const navigate = useUiStore((s) => s.navigate);
  const width = useUiStore((s) => s.width);
  const collapsed = useUiStore((s) => s.collapsed);
  const searchOpen = useUiStore((s) => s.searchOpen);
  const closeSearchState = useUiStore((s) => s.closeSearch);
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);

  const selectedProject = useProjectsStore((s) => s.selected);
  const addProjectToList = useProjectsStore((s) => s.add);
  const pinned = useProjectsStore((s) => s.pinned);
  /** 当前项目:手动选择优先,否则跟随聚焦任务的 root。 */
  const currentRoot = selectedProject ?? focusedRoot;

  // 打开过的工作区自动入项目列表(持久化)——聚焦任务的项目要能被切回来。
  useEffect(() => {
    if (focusedRoot) addProjectToList(focusedRoot);
  }, [focusedRoot, addProjectToList]);

  // 口径唯一来源:utils/tasks.ts(空会话不进列表等产品语义)。
  const live = useMemo(() => liveTasks(tasks), [tasks]);

  const taskCountOf = useMemo(() => {
    const counts = taskCountsByRoot(live);
    return (root: string) => counts.get(root) ?? 0;
  }, [live]);

  /** 当前项目的任务(置顶前置;搜索时在其中过滤)。 */
  const currentProjectTasks = useMemo(
    () => projectTasks(live, currentRoot, query, pinned),
    [live, currentRoot, query, pinned],
  );

  const archivedCount = useMemo(() => archivedTasks(tasks).length, [tasks]);

  const closeSearch = () => {
    closeSearchState();
    setQuery('');
  };

  const contextMenu = useTaskContextMenu();

  const navRow = (
    target: Exclude<View, 'settings'>,
    icon: React.ReactNode,
    label: string,
    badge?: string,
  ) => (
    <button
      type="button"
      className={`nav-row ${view === target ? 'nav-row-active' : ''}`}
      onClick={() => navigate(target)}
    >
      <span className="nav-row-icon">{icon}</span>
      <span className="nav-row-label">{label}</span>
      {badge ? <span className="nav-row-badge">{badge}</span> : null}
    </button>
  );

  if (collapsed) return null;

  return (
    <aside className="sidebar" style={{ width: `${width}px` }}>
      <div className="sidebar-head">
        <ProjectSwitcher
          currentRoot={currentRoot}
          taskCountOf={taskCountOf}
          onImport={() => setImporting(true)}
        />
        <button
          type="button"
          className="new-task-btn"
          onClick={() => newTask(currentRoot)}
          disabled={running}
          title={running ? t('sidebar.busy') : undefined}
        >
          <PlusIcon size={14} />
          {t('sidebar.newTask')}
        </button>
      </div>
      <nav className="nav-list">
        {navRow('home', <HouseIcon size={15} />, t('nav.home'))}
        {navRow(
          'task',
          <ChatTeardropDotsIcon size={15} />,
          t('nav.tasks'),
          currentRoot ? String(taskCountOf(currentRoot)) : undefined,
        )}
        {navRow(
          'archive',
          <ArchiveIcon size={15} />,
          t('nav.archive'),
          archivedCount > 0 ? String(archivedCount) : undefined,
        )}
      </nav>
      <div className="sidebar-section-head">
        <span className="sidebar-section-title">{t('sidebar.tasksSection')}</span>
      </div>
      <TaskList
        tasks={tasks}
        list={currentProjectTasks}
        activeId={storeId}
        pinned={pinned}
        searchOpen={searchOpen}
        query={query}
        onQueryChange={setQuery}
        onCloseSearch={closeSearch}
        onContextMenu={contextMenu.open}
      />
      <div className="sidebar-footer">
        <button
          type="button"
          className="nav-row"
          onClick={() => useUiStore.getState().openSettings()}
        >
          <span className="nav-row-icon">
            <GearIcon size={15} />
          </span>
          <span className="nav-row-label">{t('sidebar.settings')}</span>
        </button>
      </div>
      <SidebarResizer />
      {contextMenu.element}
      {importing ? <ImportProjectDialog onClose={() => setImporting(false)} /> : null}
    </aside>
  );
}
