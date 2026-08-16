/**
 * App 布局(ZCode 式双栏):
 *
 * Sidebar(顶部拖拽区/任务列表/底部设置)| MainArea[ ConnectionBanner /
 * SplitPane( ChatPane(EmptyState+Timeline/TodoPanel/StatusLine/PermissionCard/
 * Composer)| ReviewPanel(代码评审面板)) ]
 *
 * ZCode 无顶栏:权限档与模型选择器在 Composer 工具栏,语言/连接状态在侧栏
 * 底部 Settings 菜单。侧栏收起时主区顶部补一条浮层(拖拽区 + 展开按钮)。
 */

import React, { useEffect } from 'react';
import type { PermissionDecision } from '@core/events';
import { initBridge } from './bridge/client.js';
import { useDesktopStore } from './state/desktopStore.js';
import { useUiStore } from './state/uiStore.js';
import { useLocale, t } from './i18n/index.js';
import { Sidebar } from './components/Sidebar.js';
import { Timeline } from './components/Timeline.js';
import { TodoPanel } from './components/TodoPanel.js';
import { StatusLine } from './components/StatusLine.js';
import { Composer } from './components/Composer.js';
import { PermissionCard } from './components/PermissionCard.js';
import { ReviewPanel } from './components/ReviewPanel.js';

/** 审批卡挂在 Composer 上方;决策经 RPC 回 main 侧的 asker。 */
function PermissionSection() {
  const permission = useDesktopStore((s) => s.permission);
  if (!permission) return null;
  const onDecide = (decision: PermissionDecision) => {
    void window.mojocode.rpc({ kind: 'permission', id: permission.id, decision });
  };
  return (
    <div className="permission-wrap conv-col">
      <PermissionCard request={permission} onDecide={onDecide} />
    </div>
  );
}

/** 连接断开提示条(重连成功自动消失)。 */
function ConnectionBanner() {
  useLocale();
  const connection = useDesktopStore((s) => s.connection);
  if (connection !== 'lost') return null;
  return <div className="connection-banner">{t('connection.lost')}</div>;
}

/** 侧栏收起时的顶部浮层:窗口拖拽区 + 展开按钮 + 新建任务(ZCode 同款)。 */
function CollapsedOverlay() {
  useLocale();
  const collapsed = useUiStore((s) => s.collapsed);
  const running = useDesktopStore((s) => s.snapshot?.agent.isRunning ?? false);
  const toggleCollapsed = useUiStore((s) => s.toggleCollapsed);
  if (!collapsed) return null;
  const newSession = () => {
    if (running) return;
    void window.mojocode.rpc({ kind: 'newSession' }).catch((error) => console.error('newSession 失败', error));
  };
  return (
    <div className="app-overlay">
      <button
        type="button"
        className="sidebar-collapse"
        onClick={toggleCollapsed}
        title={t('sidebar.expand')}
      >
        »
      </button>
      <button
        type="button"
        className="sidebar-collapse"
        onClick={newSession}
        disabled={running}
        title={t('sidebar.newTask')}
      >
        +
      </button>
    </div>
  );
}

/** ⌘B/Ctrl+B 切换侧栏(文档级,无菜单环境下直达 renderer)。 */
function useSidebarShortcut(): void {
  const toggleCollapsed = useUiStore((s) => s.toggleCollapsed);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleCollapsed]);
}

export function App() {
  useEffect(() => initBridge(), []);
  useSidebarShortcut();
  return (
    <div className="shell">
      <Sidebar />
      <div className="app">
        <CollapsedOverlay />
        <ConnectionBanner />
        <div className="main-split">
          <div className="chat-pane">
            <Timeline />
            <TodoPanel />
            <StatusLine />
            <PermissionSection />
            <Composer />
          </div>
          <ReviewPanel />
        </div>
      </div>
    </div>
  );
}
