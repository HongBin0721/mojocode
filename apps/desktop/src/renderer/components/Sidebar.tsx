/**
 * 侧栏(ZCode 形态):
 *  1. 顶部拖拽区(mac 让位红绿灯 96px):logo + 折叠按钮;
 *  2. 图标导航行(新建任务 ⌘N / 搜索 ⌘K,搜索行展开输入框);
 *  3. 「项目」区:标题行右侧「+ 添加项目」走原生目录选择器;项目 = 手动
 *     添加的文件夹列表(projectsStore,localStorage)∪ 当前工作区 root ∪
 *     会话里出现过的 root。每组是可折叠的文件夹标题行 + 缩进任务行(标题
 *     左、相对时间右,运行中的会话带脉冲点),空项目显示「暂无任务」;
 *     悬停出「新任务」(其他项目 → 重启 sidecar 切工作区)与「移除」;
 *  4. 底部 Settings 菜单(语言切换)。
 *
 * 右缘可拖宽(264~50vw,双击复位),⌘B 折叠(App 里监听)。
 */

import React, { memo, useEffect, useMemo, useState } from 'react';
import type { SessionMetaSummary } from '../../shared/ipc.js';
import { useDesktopStore } from '../state/desktopStore.js';
import { useUiStore } from '../state/uiStore.js';
import { useProjectsStore } from '../state/projectsStore.js';
import { newSession } from '../state/actions.js';
import { formatRelativeTime, projectName } from '../utils/format.js';
import { t, useLocale, setLocale, getLocale, type Locale } from '../i18n/index.js';
import { MenuPopover } from './Menu.js';
import { CirclePlusIcon, FolderIcon, GearIcon, PlusIcon, SearchIcon } from './icons.js';

/** 任务行:标题左、相对时间右;仅运行中的会话带脉冲点(ZCode 形态)。
 * memo:Sidebar 随每次 state 推送重渲染,N 条 props 稳定的行不必跟着重建。
 * 行内的相对时间与 title 都是本地化文案,自己订阅 locale——props 不变时
 * memo 会拦掉父组件的重渲染,不订阅的话切语言后时间戳停在旧语言。 */
const SessionRow = memo(function SessionRow({
  session,
  active,
  running,
}: {
  session: SessionMetaSummary;
  active: boolean;
  running: boolean;
}) {
  useLocale();
  const onOpen = () => {
    void window.mojocode.rpc({ kind: 'resumeSession', idOrPrefix: session.id }).catch((error) => {
      console.error('resume 失败', error);
    });
  };
  return (
    <button
      type="button"
      className={`session-row ${active ? 'session-active' : ''}`}
      onClick={onOpen}
    >
      {running ? <span className="session-dot" title={t('badge.running')} /> : null}
      <span className="session-title">{session.title || session.id.slice(0, 8)}</span>
      <span className="session-when">{formatRelativeTime(session.updatedAt)}</span>
    </button>
  );
});

/** 底部 Settings 菜单:语言切换。 */
function SettingsMenu() {
  useLocale();
  const locale = getLocale();
  return (
    <MenuPopover
      label={
        <span className="settings-row">
          <span className="side-nav-icon">
            <GearIcon size={16} />
          </span>
          {t('sidebar.settings')}
        </span>
      }
      title={t('sidebar.settings')}
      width={260}
      placement="top"
      block
    >
      <button
        type="button"
        className="menu-item"
        onClick={() => setLocale(locale === 'zh-CN' ? 'en' : ('zh-CN' as Locale))}
      >
        <span className="menu-item-label">{t('settings.language')}</span>
        <span className="menu-item-desc">{locale === 'zh-CN' ? 'English' : '中文'}</span>
      </button>
    </MenuPopover>
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
        setDragging(true);
        const move = (ev: MouseEvent) => {
          setWidth(ev.clientX - sidebarLeft, window.innerWidth);
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
  const sessions = useDesktopStore((s) => s.sessions);
  // 窄选择器:Sidebar 随每个 bus 事件收 state 推送,订阅整份 snapshot 会把
  // 流式轮次里的几十次推送全变成全树重渲染。
  const storeId = useDesktopStore((s) => s.snapshot?.storeId);
  const running = useDesktopStore((s) => s.snapshot?.agent.isRunning ?? false);
  const currentRoot = useDesktopStore((s) => s.snapshot?.root);
  const width = useUiStore((s) => s.width);
  const collapsed = useUiStore((s) => s.collapsed);
  const toggleCollapsed = useUiStore((s) => s.toggleCollapsed);
  const searchOpen = useUiStore((s) => s.searchOpen);
  const openSearch = useUiStore((s) => s.openSearch);
  const closeSearchState = useUiStore((s) => s.closeSearch);
  const [query, setQuery] = useState('');

  const projects = useProjectsStore((s) => s.projects);
  const addProjectToList = useProjectsStore((s) => s.add);
  const removeProjectFromList = useProjectsStore((s) => s.remove);
  const [collapsedRoots, setCollapsedRoots] = useState<ReadonlySet<string>>(new Set());

  // 打开过的工作区自动入项目列表(持久化)——否则切走后原项目会从侧栏消失。
  useEffect(() => {
    if (currentRoot) addProjectToList(currentRoot);
  }, [currentRoot, addProjectToList]);

  const filtered = useMemo(() => {
    // 0 消息的空会话不进列表(每次启动/切换工作区 server 都会留一个,点进
    // 去时间线是空的,只添乱)——当前会话除外,不然新任务在侧栏里没有落点。
    const list = (sessions ?? []).filter(
      (session) => session.messageCount > 0 || session.id === storeId,
    );
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (session) =>
        session.title.toLowerCase().includes(q) || session.id.toLowerCase().startsWith(q),
    );
  }, [sessions, query, storeId]);

  /**
   * 项目分组:当前 root 置顶,其余按手动列表序(currentRoot 经上面的 effect
   * 必然已在 projects 里,单列它只为置顶与首帧)。会话列表是跨工作区的
   * (bridge 以 all 拉取),但只渲染项目列表里的 root——「项目」是用户手动
   * 管理的集合,不该被别处跑过的会话撑开。搜索时隐藏无命中的组。
   */
  const groups = useMemo(() => {
    const byRoot = new Map<string, SessionMetaSummary[]>();
    for (const session of filtered) {
      const list = byRoot.get(session.root);
      if (list) list.push(session);
      else byRoot.set(session.root, [session]);
    }
    const roots = [...new Set([...(currentRoot ? [currentRoot] : []), ...projects])];
    const searching = query.trim().length > 0;
    return roots
      .map((root) => ({ root, list: byRoot.get(root) ?? [] }))
      .filter((group) => !searching || group.list.length > 0);
  }, [filtered, projects, currentRoot, query]);

  /** 「+ 添加项目」:原生目录选择器,选中即入列表(不切换工作区)。 */
  const pickProject = () => {
    void window.mojocode
      .pickDirectory()
      .then((root) => {
        if (root) addProjectToList(root);
      })
      .catch((error: unknown) => console.error('pickDirectory 失败', error));
  };

  /** 项目组里的「新任务」:当前项目直接开新会话,其他项目先切工作区。 */
  const newTaskIn = (root: string) => {
    if (running) return;
    if (root === currentRoot) {
      newSession();
      return;
    }
    void window.mojocode
      .switchWorkspace(root)
      .catch((error: unknown) => console.error('switchWorkspace 失败', error));
  };

  const toggleGroup = (root: string) => {
    setCollapsedRoots((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  };

  const closeSearch = () => {
    closeSearchState();
    setQuery('');
  };

  return (
    <aside
      className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}
      style={collapsed ? undefined : { width: `${width}px` }}
    >
      <div className="sidebar-top">
        <span className="sidebar-logo">M</span>
        <button
          type="button"
          className="sidebar-collapse"
          onClick={toggleCollapsed}
          title={t('sidebar.collapse')}
        >
          «
        </button>
      </div>
      <div className="sidebar-body">
        <button
          type="button"
          className="side-nav"
          onClick={newSession}
          disabled={running}
          title={running ? t('sidebar.busy') : undefined}
        >
          <span className="side-nav-icon">
            <CirclePlusIcon size={15} />
          </span>
          <span className="side-nav-label">{t('sidebar.newTask')}</span>
          <kbd className="side-kbd">⌘N</kbd>
        </button>
        {sessions !== undefined ? (
          <button
            type="button"
            className="side-nav"
            onClick={() => (searchOpen ? closeSearch() : openSearch())}
          >
            <span className="side-nav-icon">
              <SearchIcon size={15} />
            </span>
            <span className="side-nav-label">{t('sidebar.searchNav')}</span>
            <kbd className="side-kbd">⌘K</kbd>
          </button>
        ) : null}
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
        <div className="sidebar-section-head">
          <span className="sidebar-section-title">{t('sidebar.projects')}</span>
          <button
            type="button"
            className="section-icon"
            title={t('sidebar.addProject')}
            onClick={pickProject}
          >
            <PlusIcon size={14} />
          </button>
        </div>
        <div className="session-list">
          {sessions === undefined ? (
            <div className="sidebar-empty">{t('sidebar.unsupported')}</div>
          ) : query && groups.length === 0 ? (
            <div className="sidebar-empty">{t('sidebar.noMatch')}</div>
          ) : (
            groups.map(({ root, list }) => {
              const collapsed = collapsedRoots.has(root);
              const isCurrent = root === currentRoot;
              return (
                <div key={root} className="session-group">
                  <div className={`session-group-title ${isCurrent ? 'session-group-current' : ''}`}>
                    <button
                      type="button"
                      className="session-group-toggle"
                      title={root}
                      onClick={() => toggleGroup(root)}
                    >
                      <FolderIcon size={13} />
                      <span className="session-group-name">{projectName(root)}</span>
                      <span className="session-group-caret">{collapsed ? '▸' : '▾'}</span>
                    </button>
                    <span className="session-group-actions">
                      <button
                        type="button"
                        className="section-icon"
                        title={running ? t('sidebar.busy') : t('sidebar.newTask')}
                        disabled={running}
                        onClick={() => newTaskIn(root)}
                      >
                        <PlusIcon size={13} />
                      </button>
                      {projects.includes(root) && !isCurrent ? (
                        <button
                          type="button"
                          className="section-icon"
                          title={t('sidebar.removeProject')}
                          onClick={() => removeProjectFromList(root)}
                        >
                          ✕
                        </button>
                      ) : null}
                    </span>
                  </div>
                  {collapsed ? null : list.length === 0 ? (
                    <div className="session-group-empty">{t('sidebar.noTasks')}</div>
                  ) : (
                    list.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        active={session.id === storeId}
                        running={session.id === storeId && running}
                      />
                    ))
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
      <div className="sidebar-footer">
        <SettingsMenu />
      </div>
      {!collapsed ? <SidebarResizer /> : null}
    </aside>
  );
}
