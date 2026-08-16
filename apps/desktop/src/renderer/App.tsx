/**
 * App 布局(Codex 式双栏):
 *
 * Sidebar(三层侧栏)| MainArea[ Toolbar / ConnectionBanner / SplitPane(
 * ChatPane(Timeline/TodoPanel/StatusLine/PermissionCard/Composer)|
 * ReviewPanel(代码评审面板,M-B 落地前为空挂载点)) ]
 */

import React, { useEffect } from 'react';
import type { PermissionDecision } from '@core/events';
import { initBridge } from './bridge/client.js';
import { useDesktopStore } from './state/desktopStore.js';
import { useLocale, t } from './i18n/index.js';
import { Toolbar } from './components/Toolbar.js';
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
  return <PermissionCard request={permission} onDecide={onDecide} />;
}

/** 连接断开提示条(重连成功自动消失)。 */
function ConnectionBanner() {
  useLocale();
  const connection = useDesktopStore((s) => s.connection);
  if (connection !== 'lost') return null;
  return <div className="connection-banner">{t('connection.lost')}</div>;
}

export function App() {
  useEffect(() => initBridge(), []);
  return (
    <div className="shell">
      <Sidebar />
      <div className="app">
        <Toolbar />
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
