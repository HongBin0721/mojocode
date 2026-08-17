/**
 * App 布局(ZCode 式双栏):
 *
 * Sidebar(顶部拖拽区/任务列表/底部设置)| MainArea[ ChatTopBar(标题+项目
 * +分支 chips)/ ConnectionBanner / SplitPane( ChatPane(EmptyState+Timeline/
 * TodoPanel 浮层/StatusLine/PermissionCard/Composer)| ReviewPanel ) ]
 *
 * 权限档与模型选择器在 Composer 工具栏,语言/连接状态在侧栏底部 Settings
 * 菜单。侧栏收起时主区顶部补一条浮层(拖拽区 + 展开按钮),顶栏给它让位。
 */

import React, { useEffect } from 'react';
import type { PermissionDecision } from '@core/events';
import { initBridge } from './bridge/client.js';
import { useDesktopStore } from './state/desktopStore.js';
import { useUiStore } from './state/uiStore.js';
import { useLocale, t } from './i18n/index.js';
import { Sidebar } from './components/Sidebar.js';
import { ChatTopBar } from './components/ChatTopBar.js';
import { newSession } from './state/actions.js';
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

/**
 * 全局快捷键:⌘B 切换侧栏、⌘N 新建任务、⌘K 搜索(ZCode 同款)。
 *
 * 修饰键按平台取一个,不接受 meta||ctrl:macOS 的文本框里 ctrl+b/n/k 是系统
 * emacs 光标键(前一字符/下一行/删到行尾),两个都认的话在输入框里敲 ctrl+n
 * 会把正在写的会话换掉。
 */
function useGlobalShortcuts(): void {
  const toggleCollapsed = useUiStore((s) => s.toggleCollapsed);
  useEffect(() => {
    const mac = window.mojocode.platform === 'darwin';
    const onKey = (e: KeyboardEvent) => {
      if (!(mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        toggleCollapsed();
      } else if (key === 'n') {
        e.preventDefault();
        newSession();
      } else if (key === 'k') {
        e.preventDefault();
        // 搜索框在侧栏里;收起时先展开。
        if (useUiStore.getState().collapsed) toggleCollapsed();
        useUiStore.getState().openSearch();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleCollapsed]);
}

export function App() {
  useEffect(() => initBridge(), []);
  useGlobalShortcuts();
  return (
    <div className="shell">
      <Sidebar />
      <div className="app">
        <ChatTopBar />
        {/* 必须排在 ChatTopBar 之后:Electron 的拖拽区按文档顺序 union/subtract
            (不看 z-index),浮层若在前,按钮挖出的 no-drag 洞会被顶栏整条的
            drag 矩形重新盖回去——点「展开」变成拖窗口,侧栏永远点不开。 */}
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
