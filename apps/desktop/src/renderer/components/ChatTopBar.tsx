/**
 * 聊天列顶栏(ZCode 形态):任务标题 + 项目 chip(文件夹图标)+ git 分支
 * chip。整条是窗口拖拽区;侧栏收起时给左侧的浮层按钮让位(见 CSS)。
 *
 * 分支来自 reviewStore 的 workspaceStatus:分支是工作区级信息,只在 root
 * 变化(启动/切工作区)时刷一次——refresh 自带 in-flight 去重,与评审面板
 * 的冷启动刷新合并成一次 RPC。旧 server unsupported / 非 git 仓库时 chip
 * 不渲染。选择器全部收窄成标量:这条栏随每个 bus 事件收 state 推送,订阅
 * 整份 snapshot/status 会把流式轮次变成持续重渲染。
 */

import React, { useEffect } from 'react';
import { useDesktopStore } from '../state/desktopStore.js';
import { useReviewStore } from '../state/reviewStore.js';
import { useUiStore } from '../state/uiStore.js';
import { t, useLocale } from '../i18n/index.js';
import { projectName } from '../utils/format.js';
import { BranchIcon, FolderIcon } from './icons.js';

export function ChatTopBar() {
  useLocale();
  const root = useDesktopStore((s) => s.snapshot?.root);
  const title = useDesktopStore((s) => {
    const id = s.snapshot?.storeId;
    return (id && s.sessions?.find((session) => session.id === id)?.title) || undefined;
  });
  const collapsed = useUiStore((s) => s.collapsed);
  const branch = useReviewStore((s) => (s.status?.ok ? s.status.branch : undefined));
  const unsupported = useReviewStore((s) => s.unsupported);
  const refresh = useReviewStore((s) => s.refresh);

  useEffect(() => {
    if (root && !unsupported) void refresh();
  }, [root, unsupported, refresh]);

  if (root === undefined) return null;

  return (
    <div className={`chat-topbar ${collapsed ? 'chat-topbar-collapsed' : ''}`}>
      <span className="topbar-title">{title ?? t('topbar.newTask')}</span>
      <span className="topbar-chip">
        <FolderIcon size={13} />
        {projectName(root)}
      </span>
      {branch ? (
        <span className="topbar-chip">
          <BranchIcon size={13} />
          {branch}
        </span>
      ) : null}
    </div>
  );
}
