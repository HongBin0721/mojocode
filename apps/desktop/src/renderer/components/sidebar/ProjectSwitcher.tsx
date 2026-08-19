/**
 * 项目切换器(自 Sidebar.tsx 拆出):MenuPopover 触发器(文件夹图标 +
 * 项目名/路径 + ⇕)+ 弹层内容(项目行:名称/路径/任务数/当前勾 + 底部
 * 「导入项目文件夹」入口)。
 */

import React, { useMemo } from 'react';
import { useProjectsStore } from '../../state/projectsStore.js';
import { t, useLocale } from '../../i18n/index.js';
import { projectName } from '../../utils/format.js';
import { MenuPopover, MenuCloseContext } from '../Menu.js';
import { CaretUpDownIcon, CheckIcon, FolderPlusIcon, FolderSimpleIcon } from '../icons.js';

/** 弹层内容:项目行 + 导入入口。 */
function ProjectMenu({
  currentRoot,
  taskCountOf,
  onImport,
}: {
  currentRoot: string | undefined;
  taskCountOf: (root: string) => number;
  onImport: () => void;
}) {
  useLocale();
  const close = React.useContext(MenuCloseContext);
  const projects = useProjectsStore((s) => s.projects);
  const select = useProjectsStore((s) => s.select);

  const roots = useMemo(
    () => [...new Set([...(currentRoot ? [currentRoot] : []), ...projects])],
    [currentRoot, projects],
  );

  const importFolder = () => {
    close();
    onImport(); // 设计稿形态:打开导入对话框(拖放 + 选择)
  };

  return (
    <>
      {roots.map((root) => (
        <button
          key={root}
          type="button"
          className="menu-item project-item"
          onClick={() => {
            select(root);
            close();
          }}
        >
          <FolderSimpleIcon size={15} />
          <span className="project-item-body">
            <span className="project-item-name">{projectName(root)}</span>
            <span className="project-item-path">{root}</span>
          </span>
          <span className="project-item-count">
            {t('sidebar.taskCount', { count: String(taskCountOf(root)) })}
          </span>
          {root === currentRoot ? <CheckIcon size={13} /> : null}
        </button>
      ))}
      <button type="button" className="menu-item project-import" onClick={importFolder}>
        <FolderPlusIcon size={15} />
        {t('sidebar.importProject')}
      </button>
    </>
  );
}

export function ProjectSwitcher({
  currentRoot,
  taskCountOf,
  onImport,
}: {
  currentRoot: string | undefined;
  taskCountOf: (root: string) => number;
  onImport: () => void;
}) {
  useLocale();
  return (
    <MenuPopover
      block
      title={t('sidebar.switchProject')}
      label={
        <span className="project-trigger">
          <FolderSimpleIcon size={15} />
          <span className="project-trigger-body">
            <span className="project-trigger-name">
              {currentRoot ? projectName(currentRoot) : t('sidebar.projects')}
            </span>
            {currentRoot ? <span className="project-trigger-path">{currentRoot}</span> : null}
          </span>
          <CaretUpDownIcon size={13} />
        </span>
      }
    >
      <ProjectMenu currentRoot={currentRoot} taskCountOf={taskCountOf} onImport={onImport} />
    </MenuPopover>
  );
}
