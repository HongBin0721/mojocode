/**
 * 侧栏(Codex 设计稿形态,252px 起可拖宽):
 *  1. 项目切换器(文件夹图标 + 项目名/路径 + ⇕),弹层列出项目(任务计数、
 *     当前项目打勾)+ 底部「导入项目文件夹」(原生目录选择器);
 *  2. 全宽「+ 新建任务」按钮(落在当前项目的 root);
 *  3. 主导航:首页 / 任务(badge = 当前项目任务数)/ 归档;
 *  4. 「任务」分组:当前项目的任务行(TONE 状态点 + 标题 + 状态·时间),
 *     ⌘K 搜索行按需展开;右键菜单(重命名/归档/分支/复制/删除);
 *  5. 底部设置入口。
 *
 * 右缘可拖宽(264~50vw,双击复位),⌘B 折叠(App 里监听;折叠态的展开钮
 * 在 TitleBar)。窗口拖拽区归 TitleBar,侧栏不再承担。
 */

import React, { memo, useEffect, useMemo, useState } from 'react';
import type { TaskSummary } from '../../shared/ipc.js';
import { useDesktopStore } from '../state/desktopStore.js';
import { useUiStore, type View } from '../state/uiStore.js';
import { useProjectsStore } from '../state/projectsStore.js';
import { forkTask, newTask, openTask } from '../state/actions.js';
import { revealPath, rpcFire } from '../bridge/invoke.js';
import { taskTone, toneColorVar, toneLabelKey } from '../utils/task-tone.js';
import { formatRelativeTime, projectName } from '../utils/format.js';
import { t, useLocale } from '../i18n/index.js';
import { MenuPopover, MenuCloseContext } from './Menu.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { ImportProjectDialog } from './ImportProjectDialog.js';
import {
  ArchiveIcon,
  CopyIcon,
  FolderOpenIcon,
  GitBranchIcon,
  HashIcon,
  PencilIcon,
  PushPinIcon,
  TrashIcon,
  CaretUpDownIcon,
  ChatTeardropDotsIcon,
  CheckIcon,
  FolderPlusIcon,
  FolderSimpleIcon,
  GearIcon,
  HouseIcon,
  PlusIcon,
} from './icons.js';

/** 任务行:TONE 状态点 + 标题,第二行 状态 · 相对时间(设计稿双行形态)。 */
const TaskRow = memo(function TaskRow({
  task,
  active,
  pinned,
  onContextMenu,
}: {
  task: TaskSummary;
  active: boolean;
  pinned: boolean;
  onContextMenu: (task: TaskSummary, x: number, y: number) => void;
}) {
  useLocale();
  const tone = taskTone(task);
  return (
    <button
      type="button"
      className={`task-row ${active ? 'task-row-active' : ''}`}
      onClick={() => openTask(task.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(task, e.clientX, e.clientY);
      }}
    >
      <span className="task-row-head">
        <span className="task-dot" style={{ background: toneColorVar(tone) }} />
        <span className="task-row-title">{task.title || task.id.slice(0, 8)}</span>
        {pinned ? (
          <span className="task-pin">
            <PushPinIcon size={11} />
          </span>
        ) : null}
        {task.hasPendingPermission ? <span className="task-badge-permission" /> : null}
      </span>
      <span className="task-row-meta">
        {t(toneLabelKey(tone))} · {formatRelativeTime(task.updatedAt)}
      </span>
    </button>
  );
});

/** 项目切换器弹层内容:项目行(名称/路径/任务数/当前勾)+ 导入入口。 */
function ProjectMenu({
  currentRoot,
  taskCountOf,
  onImport,
}: {
  currentRoot: string | undefined;
  taskCountOf: (root: string) => number;
  onImport: () => void;
}) {
  useLocale();
  const close = React.useContext(MenuCloseContext);
  const projects = useProjectsStore((s) => s.projects);
  const select = useProjectsStore((s) => s.select);

  const roots = useMemo(
    () => [...new Set([...(currentRoot ? [currentRoot] : []), ...projects])],
    [currentRoot, projects],
  );

  const importFolder = () => {
    close();
    onImport(); // 设计稿形态:打开导入对话框(拖放 + 选择)
  };

  return (
    <>
      {roots.map((root) => (
        <button
          key={root}
          type="button"
          className="menu-item project-item"
          onClick={() => {
            select(root);
            close();
          }}
        >
          <FolderSimpleIcon size={15} />
          <span className="project-item-body">
            <span className="project-item-name">{projectName(root)}</span>
            <span className="project-item-path">{root}</span>
          </span>
          <span className="project-item-count">
            {t('sidebar.taskCount', { count: String(taskCountOf(root)) })}
          </span>
          {root === currentRoot ? <CheckIcon size={13} /> : null}
        </button>
      ))}
      <button type="button" className="menu-item project-import" onClick={importFolder}>
        <FolderPlusIcon size={15} />
        {t('sidebar.importProject')}
      </button>
    </>
  );
}

/** 右缘拖宽手柄:拖动钳制 264~50vw,双击复位,松手落盘。 */
function SidebarResizer() {
  const setWidth = useUiStore((s) => s.setWidth);
  const commitWidth = useUiStore((s) => s.commitWidth);
  const resetWidth = useUiStore((s) => s.resetWidth);
  const [dragging, setDragging] = useState(false);

  return (
    <div
      className={`sidebar-resizer ${dragging ? 'sidebar-resizer-active' : ''}`}
      onDoubleClick={resetWidth}
      onMouseDown={(e) => {
        // 宽度 = 手柄 X - 侧栏左缘(手柄贴侧栏右缘,随宽度移动)。
        const sidebarLeft = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
        // 右面板占宽按下时量一次(拖侧栏时它不变):上限要给中间区留最小宽。
        const reserved =
          document.querySelector('.right-panel:not(.right-panel-full)')?.getBoundingClientRect()
            .width ?? 0;
        setDragging(true);
        const move = (ev: MouseEvent) => {
          setWidth(ev.clientX - sidebarLeft, window.innerWidth, reserved);
        };
        const up = () => {
          setDragging(false);
          commitWidth();
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.style.cursor = '';
        };
        document.body.style.cursor = 'col-resize';
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      }}
    />
  );
}

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

  const selectedProject = useProjectsStore((s) => s.selected);
  const addProjectToList = useProjectsStore((s) => s.add);
  const pinned = useProjectsStore((s) => s.pinned);
  const togglePin = useProjectsStore((s) => s.togglePin);
  /** 当前项目:手动选择优先,否则跟随聚焦任务的 root。 */
  const currentRoot = selectedProject ?? focusedRoot;

  // 打开过的工作区自动入项目列表(持久化)——聚焦任务的项目要能被切回来。
  useEffect(() => {
    if (focusedRoot) addProjectToList(focusedRoot);
  }, [focusedRoot, addProjectToList]);

  /**
   * 未归档且已有真实内容的任务。空会话不进列表(聚焦中的也不例外):
   * 新建任务先开聊天视图,首条消息落地后行才出现(对齐 Codex/zcode)。
   */
  const liveTasks = useMemo(
    () => (tasks ?? []).filter((task) => task.messageCount > 0 && !task.archivedAt),
    [tasks],
  );

  const taskCountOf = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of liveTasks) counts.set(task.root, (counts.get(task.root) ?? 0) + 1);
    return (root: string) => counts.get(root) ?? 0;
  }, [liveTasks]);

  /** 当前项目的任务(置顶前置;搜索时在其中过滤)。 */
  const projectTasks = useMemo(() => {
    const list = liveTasks.filter((task) => task.root === currentRoot);
    const q = query.trim().toLowerCase();
    const filtered = q
      ? list.filter(
          (task) => task.title.toLowerCase().includes(q) || task.id.toLowerCase().startsWith(q),
        )
      : list;
    // 置顶前置,置顶内与未置顶内都保持 updatedAt 倒序(list 本身已按此排序)。
    const pinnedSet = new Set(pinned);
    return [
      ...filtered.filter((task) => pinnedSet.has(task.id)),
      ...filtered.filter((task) => !pinnedSet.has(task.id)),
    ];
  }, [liveTasks, currentRoot, query, pinned]);

  const archivedCount = useMemo(
    () => (tasks ?? []).filter((task) => task.archivedAt).length,
    [tasks],
  );

  const closeSearch = () => {
    closeSearchState();
    setQuery('');
  };

  const [contextMenu, setContextMenu] = useState<
    { task: TaskSummary; x: number; y: number } | undefined
  >();
  const [renaming, setRenaming] = useState<string | undefined>();
  const [importing, setImporting] = useState(false);

  /** 右键菜单条目:按可用能力条件渲染(缺失即不显示,不做假按钮)。 */
  const contextItems = (task: TaskSummary): ContextMenuItem[] => [
    {
      id: 'pin',
      label: pinned.includes(task.id) ? t('ctxMenu.unpin') : t('ctxMenu.pin'),
      icon: <PushPinIcon size={14} />,
    },
    { id: 'rename', label: t('ctxMenu.rename'), icon: <PencilIcon size={14} /> },
    { id: 'archive', label: t('ctxMenu.archive'), icon: <ArchiveIcon size={14} /> },
    {
      id: 'reveal',
      label: t('ctxMenu.reveal'),
      icon: <FolderOpenIcon size={14} />,
      separatorBefore: true,
    },
    { id: 'copyRoot', label: t('ctxMenu.copyRoot'), icon: <CopyIcon size={14} /> },
    { id: 'copyId', label: t('ctxMenu.copyId'), icon: <HashIcon size={14} /> },
    {
      id: 'fork',
      label: t('ctxMenu.fork'),
      icon: <GitBranchIcon size={14} />,
      separatorBefore: true,
    },
    {
      id: 'delete',
      label: t('ctxMenu.delete'),
      icon: <TrashIcon size={14} />,
      separatorBefore: true,
      danger: true,
    },
  ];

  const runContextAction = (task: TaskSummary, id: string): void => {
    switch (id) {
      case 'pin':
        togglePin(task.id);
        return;
      case 'reveal':
        revealPath(task.root);
        return;
      case 'rename':
        setRenaming(task.id);
        return;
      case 'archive':
        rpcFire(
          { kind: 'archiveSession', id: task.id, archived: true },
          { errorKey: 'notice.archiveFailed' },
        );
        return;
      case 'fork':
        forkTask(task.root, task.id);
        return;
      case 'copyRoot':
        void navigator.clipboard?.writeText(task.root);
        return;
      case 'copyId':
        void navigator.clipboard?.writeText(task.id);
        return;
      case 'delete':
        // 活跃会话由 server 拒删(英文错误经 toast 可见)。
        rpcFire({ kind: 'deleteSession', id: task.id }, { errorKey: 'notice.deleteFailed' });
        return;
      default:
        return;
    }
  };

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
        <MenuPopover
          block
          title={t('sidebar.switchProject')}
          label={
            <span className="project-trigger">
              <FolderSimpleIcon size={15} />
              <span className="project-trigger-body">
                <span className="project-trigger-name">
                  {currentRoot ? projectName(currentRoot) : t('sidebar.projects')}
                </span>
                {currentRoot ? <span className="project-trigger-path">{currentRoot}</span> : null}
              </span>
              <CaretUpDownIcon size={13} />
            </span>
          }
        >
          <ProjectMenu
            currentRoot={currentRoot}
            taskCountOf={taskCountOf}
            onImport={() => setImporting(true)}
          />
        </MenuPopover>
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
      {searchOpen ? (
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
      ) : null}
      <div className="task-list">
        {tasks === undefined ? (
          <div className="sidebar-empty">{t('sidebar.unsupported')}</div>
        ) : projectTasks.length === 0 ? (
          <div className="sidebar-empty">{query ? t('sidebar.noMatch') : t('sidebar.noTasks')}</div>
        ) : (
          projectTasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              active={task.id === storeId}
              pinned={pinned.includes(task.id)}
              onContextMenu={(target, x, y) => setContextMenu({ task: target, x, y })}
            />
          ))
        )}
      </div>
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
      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          title={contextMenu.task.title || contextMenu.task.id.slice(0, 8)}
          items={contextItems(contextMenu.task)}
          onPick={(id) => runContextAction(contextMenu.task, id)}
          onClose={() => setContextMenu(undefined)}
        />
      ) : null}
      {importing ? <ImportProjectDialog onClose={() => setImporting(false)} /> : null}
      {renaming ? (
        <RenameDialog
          taskId={renaming}
          initial={(tasks ?? []).find((task) => task.id === renaming)?.title ?? ''}
          onClose={() => setRenaming(undefined)}
        />
      ) : null}
    </aside>
  );
}

/** 重命名对话框(右键菜单「重命名」):提交走 renameSession RPC。 */
function RenameDialog({
  taskId,
  initial,
  onClose,
}: {
  taskId: string;
  initial: string;
  onClose: () => void;
}) {
  useLocale();
  const [value, setValue] = useState(initial);
  const submit = () => {
    const title = value.trim();
    if (!title) return;
    rpcFire({ kind: 'renameSession', id: taskId, title }, { errorKey: 'notice.renameFailed' });
    onClose();
  };
  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="overlay-card overlay-card-sm" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-title">{t('ctxMenu.rename')}</div>
        <input
          className="rename-input"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onClose();
          }}
        />
        <div className="overlay-actions">
          <button type="button" onClick={onClose}>
            {t('panel.discardCancel')}
          </button>
          <button type="button" className="btn-primary" disabled={!value.trim()} onClick={submit}>
            {t('ctxMenu.renameSave')}
          </button>
        </div>
      </div>
    </div>
  );
}
