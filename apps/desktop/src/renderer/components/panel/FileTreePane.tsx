/**
 * 文件 tab(自 RightPanel.tsx 拆出):惰性 listFiles 组树 + changedFiles
 * badge + 点文件预览。树算法在 utils/file-tree.ts。
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { FileContentSummary } from '../../../shared/ipc.js';
import { rpcCall } from '../../bridge/invoke.js';
import { useDesktopStore } from '../../state/desktopStore.js';
import { t, useLocale } from '../../i18n/index.js';
import { buildFileTree, type TreeNode } from '../../utils/file-tree.js';
import { CaretDownIcon, CaretUpIcon, FileCodeIcon, FolderSimpleIcon } from '../icons.js';

export function FileTreePane() {
  useLocale();
  const changedFiles = useDesktopStore((s) => s.snapshot?.changedFiles);
  const [files, setFiles] = useState<string[] | undefined>();
  const [error, setError] = useState(false);
  const [openDirs, setOpenDirs] = useState<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = useState<FileContentSummary | undefined>();

  useEffect(() => {
    void rpcCall({ kind: 'listFiles' })
      .then((result) => setFiles(result.files))
      .catch(() => setError(true));
  }, []);

  const tree = useMemo(() => buildFileTree(files ?? []), [files]);
  const changedMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of changedFiles ?? []) map.set(entry.path, entry.count);
    return map;
  }, [changedFiles]);

  const openFile = (path: string) => {
    void rpcCall({ kind: 'readFile', path })
      .then(setPreview)
      .catch(() => setPreview({ ok: false, reason: 'not-found', path, size: 0, truncated: false }));
  };

  if (error) return <div className="review-degraded">{t('files.unsupported')}</div>;
  if (!files) return <div className="review-loading">{t('review.loading')}</div>;

  if (preview) {
    return (
      <div className="file-preview">
        <div className="file-preview-head">
          <button type="button" className="review-icon" onClick={() => setPreview(undefined)}>
            ←
          </button>
          <span className="file-preview-path">{preview.path}</span>
        </div>
        {preview.ok ? (
          <pre className="file-preview-body">{preview.content}</pre>
        ) : (
          <div className="review-degraded">
            {t(`files.fail.${preview.reason ?? 'not-found'}` as 'files.fail.binary')}
          </div>
        )}
      </div>
    );
  }

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const pad = 9 + depth * 16;
      if (node.children) {
        const open = openDirs.has(node.path);
        return (
          <React.Fragment key={node.path}>
            <button
              type="button"
              className="tree-row"
              style={{ paddingLeft: `${pad}px` }}
              onClick={() =>
                setOpenDirs((prev) => {
                  const next = new Set(prev);
                  if (next.has(node.path)) next.delete(node.path);
                  else next.add(node.path);
                  return next;
                })
              }
            >
              <FolderSimpleIcon size={13} />
              <span className="tree-name">{node.name}</span>
              <span className="tree-caret">{open ? <CaretUpIcon size={11} /> : <CaretDownIcon size={11} />}</span>
            </button>
            {open ? renderNodes(node.children, depth + 1) : null}
          </React.Fragment>
        );
      }
      const changed = changedMap.get(node.path);
      return (
        <button
          key={node.path}
          type="button"
          className={`tree-row ${changed ? 'tree-row-changed' : ''}`}
          style={{ paddingLeft: `${pad}px` }}
          onClick={() => openFile(node.path)}
        >
          <FileCodeIcon size={13} />
          <span className="tree-name">{node.name}</span>
          {changed ? <span className="tree-badge">+{changed}</span> : null}
        </button>
      );
    });

  return <div className="file-tree">{renderNodes(tree, 0)}</div>;
}
