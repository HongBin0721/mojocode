/**
 * 危险操作确认框骨架:Modal(overlay 形态)+ 标题 + 说明 + 可选清单区 +
 * 取消/危险确认钮。DeleteConfirm(删除会话)与 DiscardConfirm(丢弃改动)
 * 此前各写一份同构标记,收拢到这里——第三个确认框不该再抄一遍。
 */

import React from 'react';
import { Modal } from './Modal.js';

export function ConfirmDialog({
  title,
  note,
  cancelLabel,
  confirmLabel,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  note: string;
  cancelLabel: string;
  /** 确认钮恒为危险样式(btn-danger)——非危险确认不该用这个骨架。 */
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  /** 可选清单区(如丢弃确认的变更文件列表),插在说明与按钮之间。 */
  children?: React.ReactNode;
}) {
  return (
    <Modal variant="overlay" ariaLabel={title} onClose={onClose}>
      <div className="overlay-title">{title}</div>
      <div className="overlay-note">{note}</div>
      {children}
      <div className="overlay-actions">
        <button type="button" onClick={onClose}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className="btn-danger"
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
