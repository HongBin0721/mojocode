/**
 * 归档视图(设计稿的历史任务表格):列出 archivedAt 非空的会话。
 * 设计稿里的「结果 / 改动 / 耗时」列核心不记录,以「项目 / 更新时间 /
 * 消息数」如实替代——不造假数据。行点击重新打开;悬停出「取消归档」。
 */

import React, { useMemo } from 'react';
import { useDesktopStore } from '../state/desktopStore.js';
import { useUiStore } from '../state/uiStore.js';
import { openTask } from '../state/actions.js';
import { rpcFire } from '../bridge/invoke.js';
import { formatRelativeTime, projectName } from '../utils/format.js';
import { t, useLocale } from '../i18n/index.js';

export function ArchiveView() {
  useLocale();
  const tasks = useDesktopStore((s) => s.tasks);
  const navigate = useUiStore((s) => s.navigate);

  const archived = useMemo(
    () =>
      (tasks ?? [])
        .filter((task) => task.archivedAt)
        .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '')),
    [tasks],
  );

  const unarchive = (id: string) => {
    rpcFire({ kind: 'archiveSession', id, archived: false }, { errorKey: 'notice.archiveFailed' });
  };

  return (
    <div className="archive-view">
      <h1 className="archive-title">{t('archive.title')}</h1>
      <div className="archive-desc">{t('archive.desc')}</div>
      {archived.length === 0 ? (
        <div className="home-empty">{t('archive.empty')}</div>
      ) : (
        <table className="archive-table">
          <thead>
            <tr>
              <th>{t('archive.colTask')}</th>
              <th>{t('archive.colProject')}</th>
              <th className="archive-num">{t('archive.colMessages')}</th>
              <th className="archive-num">{t('archive.colUpdated')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {archived.map((task) => (
              <tr
                key={task.id}
                className="archive-row"
                onClick={() => {
                  openTask(task.id);
                  navigate('task');
                }}
              >
                <td>{task.title || task.id.slice(0, 8)}</td>
                <td className="archive-mono">{projectName(task.root)}</td>
                <td className="archive-num archive-mono">{task.messageCount}</td>
                <td className="archive-num">{formatRelativeTime(task.updatedAt)}</td>
                <td className="archive-num">
                  <button
                    type="button"
                    className="archive-action"
                    onClick={(e) => {
                      e.stopPropagation();
                      unarchive(task.id);
                    }}
                  >
                    {t('archive.unarchive')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
