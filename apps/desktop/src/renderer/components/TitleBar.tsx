/**
 * 44px 常驻标题栏(设计稿):整条是窗口拖拽区(mac 红绿灯经 --topbar-lead
 * 让位),左侧「项目 / 分支 ▾」切换器,右侧评审面板切换钮。task 视图之外
 * 只剩拖拽区(设置页/首页/归档不放控件)。
 *
 * 拖拽区纪律(App.tsx 的既有陷阱):Electron 按文档顺序 union/subtract,
 * 本条自身 drag、内部按钮 no-drag,同一容器内不会互相覆盖。
 * 分支切换:菜单打开时才拉 reviewTargets(RPC 失败/非 git 仓库降级为只读
 * chip);切换走 switchBranch RPC,脏树被 server 以 reason 'dirty' 拒绝。
 */

import React, { useEffect, useState } from 'react';
import type { ReviewTargetsSummary } from '../../shared/ipc.js';
import { rpcCall } from '../bridge/invoke.js';
import { useDesktopStore } from '../state/desktopStore.js';
import { useReviewStore } from '../state/reviewStore.js';
import { useUiStore } from '../state/uiStore.js';
import { newTask } from '../state/actions.js';
import { t, useLocale } from '../i18n/index.js';
import { projectName } from '../utils/format.js';
import { MenuPopover, MenuCloseContext } from './Menu.js';
import {
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  CaretDownIcon,
  CheckIcon,
  GitBranchIcon,
} from './icons.js';

/** 分支菜单内容:打开(挂载)时才拉分支列表,选中即 switchBranch。 */
function BranchMenu({ current }: { current: string | undefined }) {
  useLocale();
  const close = React.useContext(MenuCloseContext);
  const refresh = useReviewStore((s) => s.refresh);
  const [targets, setTargets] = useState<ReviewTargetsSummary | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    void rpcCall({ kind: 'reviewTargets' })
      .then(setTargets)
      .catch(() => setError(t('titlebar.branchLoadFailed')));
  }, []);

  const pick = (name: string) => {
    if (switching || name === current) return;
    setSwitching(true);
    void rpcCall({ kind: 'switchBranch', name })
      .then((result) => {
        if (result.ok) {
          close();
          void refresh(); // 顶栏 chip 与 Review 面板跟上新分支
        } else {
          setError(
            result.reason === 'dirty'
              ? t('titlebar.branchDirty')
              : (result.detail ?? t('titlebar.branchSwitchFailed')),
          );
        }
      })
      .catch(() => setError(t('titlebar.branchSwitchFailed')))
      .finally(() => setSwitching(false));
  };

  if (error) return <div className="menu-note">{error}</div>;
  if (!targets) return <div className="menu-note">{t('titlebar.branchLoading')}</div>;
  if (!targets.isRepo) return <div className="menu-note">{t('titlebar.notRepo')}</div>;

  const names = [
    ...(targets.currentBranch ? [{ name: targets.currentBranch, subject: '' }] : []),
    ...targets.branches,
  ];
  return (
    <>
      {names.map((branch) => (
        <button
          key={branch.name}
          type="button"
          className="menu-item branch-item"
          disabled={switching}
          onClick={() => pick(branch.name)}
        >
          <GitBranchIcon size={14} />
          <span className="branch-item-name">{branch.name}</span>
          {branch.subject ? <span className="branch-item-meta">{branch.subject}</span> : null}
          {branch.name === current ? <CheckIcon size={13} /> : null}
        </button>
      ))}
    </>
  );
}

export function TitleBar() {
  useLocale();
  const root = useDesktopStore((s) => s.snapshot?.root);
  const running = useDesktopStore((s) => s.snapshot?.agent.isRunning ?? false);
  const view = useUiStore((s) => s.view);
  const collapsed = useUiStore((s) => s.collapsed);
  const toggleCollapsed = useUiStore((s) => s.toggleCollapsed);
  const branch = useReviewStore((s) => (s.status?.ok ? s.status.branch : undefined));
  const fullReview = useUiStore((s) => s.taskLayout === 'review');
  const toggleReviewLayout = useUiStore((s) => s.toggleReviewLayout);
  const showPanel = useReviewStore((s) => s.setVisible);

  const showControls = view === 'task' && root !== undefined;

  return (
    <div className="titlebar">
      {collapsed ? (
        <span className="titlebar-group">
          <button
            type="button"
            className="titlebar-btn"
            onClick={toggleCollapsed}
            title={t('sidebar.expand')}
          >
            »
          </button>
          <button
            type="button"
            className="titlebar-btn"
            onClick={() => newTask()}
            title={t('sidebar.newTask')}
          >
            +
          </button>
        </span>
      ) : null}
      {showControls ? (
        <MenuPopover
          width={320}
          title={t('titlebar.branches')}
          label={
            <span className="branch-trigger">
              <GitBranchIcon size={14} />
              <span className="branch-trigger-project">{projectName(root)}</span>
              {branch ? (
                <>
                  <span className="branch-trigger-sep">/</span>
                  <span className="branch-trigger-branch">{branch}</span>
                </>
              ) : null}
              <CaretDownIcon size={11} />
            </span>
          }
        >
          {running ? (
            <div className="menu-note">{t('titlebar.branchBusy')}</div>
          ) : (
            <BranchMenu current={branch} />
          )}
        </MenuPopover>
      ) : null}
      <span className="titlebar-spacer" />
      {showControls ? (
        <button
          type="button"
          className="titlebar-btn"
          onClick={() => {
            // 进全宽评审时确保面板可见;退回三栏保持 visible 原状。
            if (!fullReview) showPanel(true);
            toggleReviewLayout();
          }}
          title={fullReview ? t('titlebar.closeReview') : t('titlebar.openReview')}
        >
          {fullReview ? <ArrowsInSimpleIcon size={15} /> : <ArrowsOutSimpleIcon size={15} />}
        </button>
      ) : null}
    </div>
  );
}
