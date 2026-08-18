/**
 * 导入项目对话框(设计稿):居中卡片 + 虚线拖放区 +「选择文件夹…」按钮。
 * 拖入的 File 经 preload 的 pathForFile 拿磁盘绝对路径(sandbox 下 renderer
 * 摸不到 file.path);目录判定靠 webkitGetAsEntry(拖普通文件时如实提示)。
 * 选中即入项目列表并切换过去——不动磁盘、不拉 sidecar(新任务时才 spawn)。
 */

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useProjectsStore } from '../state/projectsStore.js';
import { t, useLocale } from '../i18n/index.js';
import { FolderPlusIcon, GitBranchIcon } from './icons.js';

export function ImportProjectDialog({ onClose }: { onClose: () => void }) {
  useLocale();
  const addProject = useProjectsStore((s) => s.add);
  const select = useProjectsStore((s) => s.select);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('.select-menu')) return; // 内层浮层让位
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const finish = (root: string) => {
    addProject(root);
    select(root);
    onClose();
  };

  const choose = () => {
    void window.mojocode
      .pickDirectory()
      .then((root) => {
        if (root) finish(root);
      })
      .catch((err: unknown) => console.error('pickDirectory 失败', err));
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const item = event.dataTransfer.items[0];
    const file = event.dataTransfer.files[0];
    if (!item || !file) return;
    // webkitGetAsEntry 是目录判定的唯一同步途径;拿不到 entry 时按文件对待。
    const entry = (
      item as unknown as { webkitGetAsEntry?: () => { isDirectory: boolean } | null }
    ).webkitGetAsEntry?.();
    if (!entry?.isDirectory) {
      setError(t('importDialog.notFolder'));
      return;
    }
    finish(window.mojocode.pathForFile(file));
  };

  return createPortal(
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="overlay-card overlay-card-import" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-title">{t('importDialog.title')}</div>
        <div className="overlay-note">{t('importDialog.note')}</div>
        <div
          className={`import-drop ${dragging ? 'import-drop-active' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <FolderPlusIcon size={26} />
          <div className="import-drop-main">{t('importDialog.drop')}</div>
          <div className="import-drop-or">{t('importDialog.or')}</div>
          <button type="button" className="import-choose" onClick={choose}>
            {t('importDialog.choose')}
          </button>
        </div>
        {error ? <div className="import-error">{error}</div> : null}
        <div className="import-hint">
          <GitBranchIcon size={13} />
          {t('importDialog.hint')}
        </div>
        <div className="overlay-actions">
          <button type="button" onClick={onClose}>
            {t('importDialog.cancel')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
