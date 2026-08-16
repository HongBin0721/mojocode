/**
 * 侧栏(ZCode 三段式):
 *  1. 顶部拖拽区(mac 让位红绿灯 96px):logo + 折叠按钮;
 *  2. 任务区:「+ 新建任务」整宽按钮 → 搜索框 → 「最近任务」列表(状态点
 *     + 两行标题 + 相对时间);
 *  3. 底部 Settings 菜单(语言切换 + 连接状态展示)。
 *
 * 右缘可拖宽(264~50vw,双击复位),⌘B 折叠(App 里监听)。
 */

import React, { useMemo, useState } from 'react';
import type { SessionMetaSummary } from '../../shared/ipc.js';
import { useDesktopStore } from '../state/desktopStore.js';
import { useUiStore } from '../state/uiStore.js';
import { t, useLocale, setLocale, getLocale, type Locale } from '../i18n/index.js';
import { MenuPopover } from './Menu.js';

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return 'now';
  if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3600_000)}h`;
  return date.toLocaleDateString();
}

/** 任务行:状态点(brand=运行/实心=当前/描边=空闲)+ 两行标题 + 时间。 */
function SessionRow({
  session,
  active,
  running,
}: {
  session: SessionMetaSummary;
  active: boolean;
  running: boolean;
}) {
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
      <span
        className={`session-dot ${running ? 'session-dot-running' : active ? 'session-dot-active' : ''}`}
        title={running ? t('badge.running') : undefined}
      />
      <span className="session-main">
        <span className="session-title">{session.title || session.id.slice(0, 8)}</span>
        <span className="session-meta">{formatWhen(session.updatedAt)}</span>
      </span>
    </button>
  );
}

/** 底部 Settings 菜单:语言切换 + 连接状态(只读)。 */
function SettingsMenu() {
  useLocale();
  const connection = useDesktopStore((s) => s.connection);
  const locale = getLocale();
  return (
    <MenuPopover
      label={
        <span className="settings-row">
          <span aria-hidden>⚙</span>
          {t('sidebar.settings')}
        </span>
      }
      title={t('sidebar.settings')}
      width={260}
      placement="top"
    >
      <button
        type="button"
        className="menu-item"
        onClick={() => setLocale(locale === 'zh-CN' ? 'en' : ('zh-CN' as Locale))}
      >
        <span className="menu-item-label">{t('settings.language')}</span>
        <span className="menu-item-desc">{locale === 'zh-CN' ? 'English' : '中文'}</span>
      </button>
      <div className="menu-status-row">
        <span className={`dot dot-${connection}`} />
        {t(`connection.${connection}` as 'connection.connected')}
      </div>
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
  const snapshot = useDesktopStore((s) => s.snapshot);
  const width = useUiStore((s) => s.width);
  const collapsed = useUiStore((s) => s.collapsed);
  const toggleCollapsed = useUiStore((s) => s.toggleCollapsed);
  const [query, setQuery] = useState('');

  const storeId = snapshot?.storeId;
  const running = snapshot?.agent.isRunning ?? false;

  const filtered = useMemo(() => {
    const list = sessions ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (session) =>
        session.title.toLowerCase().includes(q) || session.id.toLowerCase().startsWith(q),
    );
  }, [sessions, query]);

  const newSession = () => {
    if (running) return;
    void window.mojocode.rpc({ kind: 'newSession' }).catch((error) => {
      console.error('newSession 失败', error);
    });
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
          className="new-task"
          onClick={newSession}
          disabled={running}
          title={running ? t('sidebar.busy') : undefined}
        >
          + {t('sidebar.newTask')}
        </button>
        {sessions !== undefined ? (
          <input
            className="task-search"
            value={query}
            placeholder={t('sidebar.search')}
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : null}
        <div className="sidebar-section-title">{t('sidebar.recent')}</div>
        <div className="session-list">
          {sessions === undefined ? (
            <div className="sidebar-empty">{t('sidebar.unsupported')}</div>
          ) : filtered.length === 0 ? (
            <div className="sidebar-empty">{query ? t('sidebar.noMatch') : t('sidebar.empty')}</div>
          ) : (
            filtered.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                active={session.id === storeId}
                running={session.id === storeId && running}
              />
            ))
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
