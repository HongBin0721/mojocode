/**
 * App 布局(Codex 设计稿):
 *
 * TitleBar(44px 常驻,窗口拖拽区 + 分支切换器 + 评审切换)
 * └ shell-body: Sidebar(项目切换/导航/任务列表)| 主区(按视图分发)
 *    - home    → HomeView(问候 + 项目卡 + 进行中)
 *    - task    → TaskHeader + SplitPane(ChatPane | ReviewPanel)
 *    - archive → ArchiveView(历史任务表格)
 *    - settings→ SettingsPage(整体替换 shell-body,自带返回侧栏)
 *
 * 拖拽区纪律:TitleBar 常驻在最前,内部按钮 no-drag——CollapsedOverlay 的
 * 文档顺序陷阱随其退役而消失(折叠态的展开钮并入 TitleBar)。
 */

import React, { useEffect } from 'react';
import type { PermissionDecision } from '@core/events';
import { initBridge } from './bridge/client.js';
import { useDesktopStore } from './state/desktopStore.js';
import { useUiStore } from './state/uiStore.js';
import { useLocale, t } from './i18n/index.js';
import { Sidebar } from './components/Sidebar.js';
import { TitleBar } from './components/TitleBar.js';
import { TaskHeader } from './components/TaskHeader.js';
import { newTask, restartTask } from './state/actions.js';
import { rpcFire } from './bridge/invoke.js';
import { platform } from './utils/host.js';
import { Timeline } from './components/Timeline.js';
import { TodoPanel } from './components/TodoPanel.js';
import { StatusLine } from './components/StatusLine.js';
import { Composer } from './components/Composer.js';
import { PermissionCard } from './components/PermissionCard.js';
import { RightPanel } from './components/RightPanel.js';
import { SettingsPage } from './components/SettingsPage.js';
import { HomeView } from './components/HomeView.js';
import { ArchiveView } from './components/ArchiveView.js';
import { NoticeHost } from './components/NoticeHost.js';

/** 审批卡挂在 Composer 上方;决策经 RPC 回 main 侧的 asker。 */
function PermissionSection() {
  const permission = useDesktopStore((s) => s.permission);
  const taskId = useDesktopStore((s) => s.focusedTaskId);
  // 多任务下有多个任务可能同时挂起审批:决策定向到发起任务,来源写在卡上。
  const sourceTask = useDesktopStore((s) =>
    (s.tasks?.length ?? 0) > 1
      ? s.tasks?.find((task) => task.id === s.focusedTaskId)?.title
      : undefined,
  );
  if (!permission) return null;
  const onDecide = (decision: PermissionDecision) => {
    rpcFire(
      { kind: 'permission', id: permission.id, decision },
      { taskId, errorKey: 'notice.permissionFailed' },
    );
  };
  return (
    <div className="permission-wrap conv-col">
      <PermissionCard request={permission} onDecide={onDecide} sourceTask={sourceTask} />
    </div>
  );
}

/** 连接断开提示条:单任务崩溃只影响它自己,给「重启任务」出口。 */
function ConnectionBanner() {
  useLocale();
  const connection = useDesktopStore((s) => s.connection);
  const taskId = useDesktopStore((s) => s.focusedTaskId);
  if (connection !== 'lost') return null;
  return (
    <div className="connection-banner">
      {t('connection.lost')}
      {taskId ? (
        <button
          type="button"
          className="banner-action"
          onClick={() => restartTask(taskId)}
        >
          {t('connection.restartTask')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * 全局快捷键:⌘B 切换侧栏、⌘N 新建任务、⌘K 搜索。
 *
 * 修饰键按平台取一个,不接受 meta||ctrl:macOS 的文本框里 ctrl+b/n/k 是系统
 * emacs 光标键(前一字符/下一行/删到行尾),两个都认的话在输入框里敲 ctrl+n
 * 会把正在写的会话换掉。
 */
function useGlobalShortcuts(): void {
  const toggleCollapsed = useUiStore((s) => s.toggleCollapsed);
  useEffect(() => {
    const mac = platform() === 'darwin';
    const onKey = (e: KeyboardEvent) => {
      if (!(mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        toggleCollapsed();
      } else if (key === 'n') {
        e.preventDefault();
        newTask();
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

/** task 视图主体:聊天列 + 右侧面板;taskLayout='review' 时面板占满主区。 */
function TaskView() {
  const fullReview = useUiStore((s) => s.taskLayout === 'review');
  if (fullReview) {
    return (
      <div className="main-split">
        <RightPanel />
      </div>
    );
  }
  return (
    <div className="main-split">
      <div className="chat-pane">
        <TaskHeader />
        <Timeline />
        <TodoPanel />
        <StatusLine />
        <PermissionSection />
        <Composer />
      </div>
      <RightPanel />
    </div>
  );
}

export function App() {
  useEffect(() => initBridge(), []);
  useGlobalShortcuts();
  const view = useUiStore((s) => s.view);
  // 全屏设置页整体替换 shell-body(自带返回侧栏);桥与快捷键保持挂载,
  // SSE/状态推送在设置页停留期间照常回流(模型设置就吃这份快照)。
  // NoticeHost(RPC 失败 toast)在两种形态下都要在场,挂在分支之外。
  return (
    <>
      {view === 'settings' ? (
        <SettingsPage />
      ) : (
        <div className="shell">
          <TitleBar />
          <div className="shell-body">
            <Sidebar />
            <div className="app">
              <ConnectionBanner />
              {view === 'home' ? (
                <HomeView />
              ) : view === 'archive' ? (
                <ArchiveView />
              ) : (
                <TaskView />
              )}
            </div>
          </div>
        </div>
      )}
      <NoticeHost />
    </>
  );
}
