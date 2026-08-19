/** 重命名对话框(自 Sidebar.tsx 拆出;右键菜单「重命名」):提交走 renameSession RPC。 */

import React, { useState } from 'react';
import { rpcFire } from '../../bridge/invoke.js';
import { t, useLocale } from '../../i18n/index.js';
import { Modal } from '../overlays/Modal.js';

export function RenameDialog({
  taskId,
  initial,
  onClose,
}: {
  taskId: string;
  initial: string;
  onClose: () => void;
}) {
  useLocale();
  const [value, setValue] = useState(initial);
  const submit = () => {
    const title = value.trim();
    if (!title) return;
    rpcFire({ kind: 'renameSession', id: taskId, title }, { errorKey: 'notice.renameFailed' });
    onClose();
  };
  return (
    <Modal variant="overlay" cardClassName="overlay-card-sm" ariaLabel={t('ctxMenu.rename')} onClose={onClose}>
      <div className="overlay-title">{t('ctxMenu.rename')}</div>
      <input
        className="rename-input"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          // Escape 由 Modal 的捕获相栈顶仲裁统一处理
        }}
      />
      <div className="overlay-actions">
        <button type="button" onClick={onClose}>
          {t('panel.discardCancel')}
        </button>
        <button type="button" className="btn-primary" disabled={!value.trim()} onClick={submit}>
          {t('ctxMenu.renameSave')}
        </button>
      </div>
    </Modal>
  );
}
