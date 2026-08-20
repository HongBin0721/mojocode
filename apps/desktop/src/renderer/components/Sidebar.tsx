/**
 * 侧栏(设计稿形态,252px 起可拖宽)——外壳:store 订阅、当前项目决议与
 * 布局组装;子件在 sidebar/ 子目录(ProjectTree / TaskRow / SidebarResizer /
 * RenameDialog / use-task-context-menu)。
 *
 * 结构:1. 主导航(首页/归档——「任务」视图经任务行进入,不占导航);
 * 2. 「项目」分组(标题行右缘 + 导入项目;⌘K 搜索行按需展开)——项目树:
 * 项目行内嵌各自任务列表,行 hover 出「新会话」钮,右键新建/移出,可拖拽
 * 排序;3. 底部设置入口。新建任务入口全部在项目行上(设计稿)。
 * 右缘可拖宽(264~50vw,双击复位),⌘B 折叠(App 里监听;折叠态的展开钮
 * 在 TitleBar)。窗口拖拽区归 TitleBar,侧栏不再承担。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useDesktopStore } from '../state/desktopStore.js';
import { useUiStore, type View } from '../state/uiStore.js';
import { useProjectsStore } from '../state/projectsStore.js';
import { archivedTasks, liveTasks } from '../utils/tasks.js';
import { t, useLocale } from '../i18n/index.js';
import { ImportProjectDialog } from './ImportProjectDialog.js';
import { ProjectTree } from './sidebar/ProjectTree.js';
import { SidebarResizer } from './sidebar/SidebarResizer.js';
import { useTaskContextMenu } from './sidebar/use-task-context-menu.js';
import { ArchiveIcon, GearIcon, HouseIcon, PlusIcon } from './icons.js';

export function Sidebar() {
  useLocale();
  const tasks = useDesktopStore((s) => s.tasks);
  // 窄选择器:Sidebar 随每个 bus 事件收 state 推送,订阅整份 snapshot 会把
  // 流式轮次里的几十次推送全变成全树重渲染。
  const storeId = useDesktopStore((s) => s.snapshot?.storeId);
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
  const projects = useProjectsStore((s) => s.projects);
  /** 当前项目:手动选择优先,否则跟随聚焦任务的 root。 */
  const currentRoot = selectedProject ?? focusedRoot;

  // 打开过的工作区自动入项目列表(持久化)——聚焦任务的项目要能被切回来。
  useEffect(() => {
    if (focusedRoot) addProjectToList(focusedRoot);
  }, [focusedRoot, addProjectToList]);

  // 口径唯一来源:utils/tasks.ts(空会话不进列表等产品语义)。
  const live = useMemo(() => liveTasks(tasks), [tasks]);

  /** 项目树的展示顺序 = projects 数组;当前 root 未入列时兜底并入(首帧)。 */
  const roots = useMemo(
    () =>
      currentRoot && !projects.includes(currentRoot) ? [...projects, currentRoot] : projects,
    [projects, currentRoot],
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
      <nav className="nav-list">
        {navRow('home', <HouseIcon size={15} />, t('nav.home'))}
        {navRow(
          'archive',
          <ArchiveIcon size={15} />,
          t('nav.archive'),
          archivedCount > 0 ? String(archivedCount) : undefined,
        )}
      </nav>
      <div className="sidebar-section-head">
        <span className="sidebar-section-title">{t('sidebar.projects')}</span>
        <button
          type="button"
          className="section-icon"
          title={t('sidebar.importProject')}
          onClick={() => setImporting(true)}
        >
          <PlusIcon size={13} />
        </button>
      </div>
      {searchOpen ? (
        <div className="sidebar-search-wrap">
          <input
            className="task-search"
            value={query}
            placeholder={t('sidebar.search')}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeSearch();
            }}
          />
        </div>
      ) : null}
      <ProjectTree
        roots={roots}
        live={live}
        unsupported={tasks === undefined}
        currentRoot={currentRoot}
        activeTaskId={storeId}
        query={query}
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
