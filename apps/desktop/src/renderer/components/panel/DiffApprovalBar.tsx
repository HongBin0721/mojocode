/**
 * 底部批准栏(自 RightPanel.tsx 拆出):notApproved(批准并提交/请求修改)
 * ⇄ approved(已提交/撤销);… 菜单(复制补丁/在编辑器打开/丢弃)与丢弃
 * 确认对话框(列出将被丢弃的清单——字面语义:untracked 会被真删)。
 */

import React, { useEffect, useRef, useState } from 'react';
import type { WorkspaceFileEntrySummary } from '../../../shared/ipc.js';
import { openPath } from '../../bridge/invoke.js';
import { useReviewStore } from '../../state/reviewStore.js';
import { useDesktopStore } from '../../state/desktopStore.js';
import { t, useLocale } from '../../i18n/index.js';
import { Modal } from '../overlays/Modal.js';
import { useOverlayLayer } from '../overlays/overlay-stack.js';
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  DotsThreeIcon,
  TrashIcon,
} from '../icons.js';

const CHANGE_LABEL: Record<WorkspaceFileEntrySummary['change'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
};

/** 丢弃确认对话框:列出将被丢弃的清单。 */
function DiscardConfirm({ onClose }: { onClose: () => void }) {
  useLocale();
  const status = useReviewStore((s) => s.status);
  const discardAll = useReviewStore((s) => s.discardAll);
  return (
    <Modal variant="overlay" ariaLabel={t('panel.discardTitle')} onClose={onClose}>
      <div className="overlay-title">{t('panel.discardTitle')}</div>
      <div className="overlay-note">{t('panel.discardNote')}</div>
      <div className="overlay-list">
        {(status?.entries ?? []).map((entry) => (
          <div key={entry.path} className="overlay-list-row">
            <span className={`review-change review-change-${entry.change}`}>
              {CHANGE_LABEL[entry.change]}
            </span>
            <span className="overlay-list-path">{entry.path}</span>
          </div>
        ))}
      </div>
      <div className="overlay-actions">
        <button type="button" onClick={onClose}>
          {t('panel.discardCancel')}
        </button>
        <button
          type="button"
          className="btn-danger"
          onClick={() => {
            onClose();
            void discardAll();
          }}
        >
          {t('panel.discardConfirm')}
        </button>
      </div>
    </Modal>
  );
}

export function DiffApprovalBar() {
  useLocale();
  const approval = useReviewStore((s) => s.approval);
  const lastCommit = useReviewStore((s) => s.lastCommit);
  const approvalError = useReviewStore((s) => s.approvalError);
  const approve = useReviewStore((s) => s.approve);
  const undoApprove = useReviewStore((s) => s.undoApprove);
  const entries = useReviewStore((s) => s.status?.entries.length ?? 0);
  const running = useDesktopStore((s) => s.snapshot?.agent.isRunning ?? false);
  const requestPrefill = useDesktopStore((s) => s.requestComposerPrefill);
  const taskTitle = useDesktopStore(
    (s) => s.tasks?.find((task) => task.id === s.snapshot?.storeId)?.title,
  );
  const root = useDesktopStore((s) => s.snapshot?.root);
  const selectedPath = useReviewStore((s) => s.selectedPath);
  const selectedDiff = useReviewStore((s) =>
    s.selectedPath ? s.fileDiffs[s.selectedPath]?.diff : undefined,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRootRef = useRef<HTMLDivElement>(null);
  // 裸菜单此前无外点关闭、无 Esc(行为缺陷):补上,DOM/类名零变化。
  // Esc 走浮层栈仲裁,与 Modal/Select/ContextMenu 同一协议。
  const menuLayer = useOverlayLayer(menuOpen);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRootRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!menuLayer.isTop()) return;
      event.stopPropagation();
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
    // menuLayer.isTop 是活引用,不进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen]);

  /** 复制为补丁:当前选中文件的 unified diff 进剪贴板。 */
  const copyPatch = () => {
    if (!selectedDiff) return;
    void navigator.clipboard?.writeText(selectedDiff).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  /** 在编辑器中打开:系统默认程序打开当前文件(绝对路径 = root + 相对路径)。 */
  const openInEditor = () => {
    if (!root || !selectedPath) return;
    openPath(`${root}/${selectedPath}`);
  };

  const committed = approval === 'committed';
  if (!committed && entries === 0) return null;

  return (
    <div className="approval-bar">
      {committed ? (
        <>
          <span className="approval-done">
            <CheckCircleIcon size={15} weight="fill" />
            {t('panel.committedTo', { branch: lastCommit?.branch ?? 'HEAD' })}
          </span>
          <button
            type="button"
            className="approval-undo"
            disabled={approval !== 'committed'}
            onClick={() => void undoApprove()}
          >
            {t('panel.undo')}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="btn-primary approval-approve"
            disabled={approval !== 'idle' || running}
            title={running ? t('panel.gitBusy') : undefined}
            onClick={() => void approve(taskTitle ? `${taskTitle}` : 'Approve pending changes')}
          >
            <CheckIcon size={13} />
            {approval === 'committing' ? t('panel.committing') : t('panel.approveCommit')}
          </button>
          <button
            type="button"
            className="approval-request"
            onClick={() => requestPrefill(t('panel.requestChangesPrefill'))}
          >
            {t('panel.requestChanges')}
          </button>
        </>
      )}
      {approvalError ? <span className="approval-error">{approvalError}</span> : null}
      <span className="toolbar-spacer" />
      <div className="approval-menu-root" ref={menuRootRef}>
        <button type="button" className="review-icon" onClick={() => setMenuOpen(!menuOpen)}>
          <DotsThreeIcon size={16} />
        </button>
        {menuOpen ? (
          <div className="approval-menu">
            <button
              type="button"
              className="menu-item approval-menu-item"
              disabled={!selectedDiff}
              onClick={() => {
                setMenuOpen(false);
                copyPatch();
              }}
            >
              <CopyIcon size={14} />
              {t('panel.copyPatch')}
            </button>
            <button
              type="button"
              className="menu-item approval-menu-item"
              disabled={!selectedPath}
              onClick={() => {
                setMenuOpen(false);
                openInEditor();
              }}
            >
              <ArrowSquareOutIcon size={14} />
              {t('panel.openEditor')}
            </button>
            <div className="ctx-separator" />
            <button
              type="button"
              className="menu-item approval-menu-item"
              disabled={running}
              onClick={() => {
                setMenuOpen(false);
                setConfirming(true);
              }}
            >
              <TrashIcon size={14} />
              {t('panel.discardAll')}
            </button>
          </div>
        ) : null}
        {copied ? <span className="approval-copied">{t('panel.copied')}</span> : null}
      </div>
      {confirming ? <DiscardConfirm onClose={() => setConfirming(false)} /> : null}
    </div>
  );
}
