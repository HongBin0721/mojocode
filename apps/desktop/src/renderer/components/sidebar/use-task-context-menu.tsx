/**
 * 任务行右键菜单(自 Sidebar.tsx 拆出成 hook):菜单/重命名开关态 +
 * 条目表 + 8 分支动作分发,渲染物经 element 返回给宿主插进 JSX。
 * 条目按可用能力条件渲染(缺失即不显示,不做假按钮)。
 */

import React, { useState } from 'react';
import type { TaskSummary } from '../../../shared/ipc.js';
import { forkTask } from '../../state/actions.js';
import { revealPath, rpcFire } from '../../bridge/invoke.js';
import { useDesktopStore } from '../../state/desktopStore.js';
import { useProjectsStore } from '../../state/projectsStore.js';
import { t } from '../../i18n/index.js';
import { ContextMenu, type ContextMenuItem } from '../ContextMenu.js';
import { RenameDialog } from './RenameDialog.js';
import {
  ArchiveIcon,
  CopyIcon,
  FolderOpenIcon,
  GitBranchIcon,
  HashIcon,
  PencilIcon,
  PushPinIcon,
  TrashIcon,
} from '../icons.js';

export function useTaskContextMenu(): {
  open: (task: TaskSummary, x: number, y: number) => void;
  element: React.ReactNode;
} {
  const tasks = useDesktopStore((s) => s.tasks);
  const pinned = useProjectsStore((s) => s.pinned);
  const togglePin = useProjectsStore((s) => s.togglePin);
  const [contextMenu, setContextMenu] = useState<
    { task: TaskSummary; x: number; y: number } | undefined
  >();
  const [renaming, setRenaming] = useState<string | undefined>();

  const contextItems = (task: TaskSummary): ContextMenuItem[] => [
    {
      id: 'pin',
      label: pinned.includes(task.id) ? t('ctxMenu.unpin') : t('ctxMenu.pin'),
      icon: <PushPinIcon size={14} />,
    },
    { id: 'rename', label: t('ctxMenu.rename'), icon: <PencilIcon size={14} /> },
    { id: 'archive', label: t('ctxMenu.archive'), icon: <ArchiveIcon size={14} /> },
    {
      id: 'reveal',
      label: t('ctxMenu.reveal'),
      icon: <FolderOpenIcon size={14} />,
      separatorBefore: true,
    },
    { id: 'copyRoot', label: t('ctxMenu.copyRoot'), icon: <CopyIcon size={14} /> },
    { id: 'copyId', label: t('ctxMenu.copyId'), icon: <HashIcon size={14} /> },
    {
      id: 'fork',
      label: t('ctxMenu.fork'),
      icon: <GitBranchIcon size={14} />,
      separatorBefore: true,
    },
    {
      id: 'delete',
      label: t('ctxMenu.delete'),
      icon: <TrashIcon size={14} />,
      separatorBefore: true,
      danger: true,
    },
  ];

  const runContextAction = (task: TaskSummary, id: string): void => {
    switch (id) {
      case 'pin':
        togglePin(task.id);
        return;
      case 'reveal':
        revealPath(task.root);
        return;
      case 'rename':
        setRenaming(task.id);
        return;
      case 'archive':
        rpcFire(
          { kind: 'archiveSession', id: task.id, archived: true },
          { errorKey: 'notice.archiveFailed' },
        );
        return;
      case 'fork':
        forkTask(task.root, task.id);
        return;
      case 'copyRoot':
        void navigator.clipboard?.writeText(task.root);
        return;
      case 'copyId':
        void navigator.clipboard?.writeText(task.id);
        return;
      case 'delete':
        // 活跃会话由 server 拒删(英文错误经 toast 可见)。
        rpcFire({ kind: 'deleteSession', id: task.id }, { errorKey: 'notice.deleteFailed' });
        return;
      default:
        return;
    }
  };

  const element = (
    <>
      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          title={contextMenu.task.title || contextMenu.task.id.slice(0, 8)}
          items={contextItems(contextMenu.task)}
          onPick={(id) => runContextAction(contextMenu.task, id)}
          onClose={() => setContextMenu(undefined)}
        />
      ) : null}
      {renaming ? (
        <RenameDialog
          taskId={renaming}
          initial={(tasks ?? []).find((task) => task.id === renaming)?.title ?? ''}
          onClose={() => setRenaming(undefined)}
        />
      ) : null}
    </>
  );

  return { open: (task, x, y) => setContextMenu({ task, x, y }), element };
}
