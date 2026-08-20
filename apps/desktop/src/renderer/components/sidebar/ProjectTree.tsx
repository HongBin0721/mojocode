/**
 * 项目树(设计稿):「项目」分组下每个项目一行(折叠箭头 + 文件夹 + 名称 +
 * hover 出现的「新会话」钮),展开后内嵌该项目的任务行(缩进 + 左侧竖线;
 * 不内滚——超过 5 条折进「显示更多(N)」,展开后尾行「收起」,逐项目记忆)。
 * 项目行可拖拽排序——排序即 projectsStore.projects 的数组顺序,落
 * localStorage;右键出项目菜单(新建会话 / 移出项目)。
 *
 * 展开/「显示更多」态在 uiStore(⌘B 折叠、进设置页会卸载本组件,手动折起
 * 的项目不该自己弹开);默认全部展开。点击项目行 = 选中并展开(已是当前
 * 项目则切换展开),点箭头只切换展开。搜索时按匹配过滤:只渲染有命中任务
 * 的项目并强制展开、不截断。空态(列表通道降级/无项目/无命中)也归这里
 * ——`.project-tree` 外壳只此一份。
 */

import React, { useMemo, useState } from 'react';
import type { TaskSummary } from '../../../shared/ipc.js';
import { useProjectsStore } from '../../state/projectsStore.js';
import { useUiStore } from '../../state/uiStore.js';
import { newTask, openProject } from '../../state/actions.js';
import { projectTasks } from '../../utils/tasks.js';
import { projectName } from '../../utils/format.js';
import { t, useLocale } from '../../i18n/index.js';
import { ContextMenu } from '../ContextMenu.js';
import { TaskRow } from './TaskRow.js';
import {
  CaretDownIcon,
  CaretRightIcon,
  CaretUpIcon,
  ChatTeardropDotsIcon,
  DotsThreeIcon,
  FolderOpenIcon,
  FolderSimpleIcon,
  MinusCircleIcon,
  PlusIcon,
} from '../icons.js';

/** 折叠阈值(设计稿):默认露出的任务行数,超出折进「显示更多」。 */
const TASK_PREVIEW_COUNT = 5;

/** 空态行(共用 `.project-tree` 外壳,保持滚动容器唯一)。 */
function EmptyTree({ messageKey }: { messageKey: Parameters<typeof t>[0] }) {
  return (
    <div className="project-tree">
      <div className="sidebar-empty">{t(messageKey)}</div>
    </div>
  );
}

export function ProjectTree({
  roots,
  live,
  unsupported,
  currentRoot,
  activeTaskId,
  query,
  onContextMenu,
}: {
  /** 展示顺序的项目 root 列表(projectsStore.projects,含兜底并入的当前 root)。 */
  roots: string[];
  /** 未归档且有内容的任务(口径在 utils/tasks.ts)。 */
  live: TaskSummary[];
  /** tasks 通道降级(会话列表读取失败)。 */
  unsupported: boolean;
  currentRoot: string | undefined;
  activeTaskId: string | undefined;
  query: string;
  onContextMenu: (task: TaskSummary, x: number, y: number) => void;
}) {
  useLocale();
  const move = useProjectsStore((s) => s.move);
  const removeProject = useProjectsStore((s) => s.remove);
  const pinned = useProjectsStore((s) => s.pinned);
  const expanded = useUiStore((s) => s.projectExpanded);
  const setExpanded = useUiStore((s) => s.setProjectExpanded);
  const showAll = useUiStore((s) => s.projectShowAll);
  const setShowAll = useUiStore((s) => s.setProjectShowAll);
  const [dragIndex, setDragIndex] = useState<number | undefined>();
  const [overIndex, setOverIndex] = useState<number | undefined>();
  const [projMenu, setProjMenu] = useState<{ root: string; x: number; y: number } | undefined>();
  const searching = query.trim().length > 0;

  const isExpanded = (root: string) => expanded[root] ?? true;

  const pickProject = (root: string) => {
    if (root === currentRoot) {
      setExpanded(root, !isExpanded(root));
      return;
    }
    setExpanded(root, true);
    openProject(root);
  };

  /** 项目行的「新会话」:展开该项目并在其 root 下新建任务。 */
  const newSessionIn = (root: string) => {
    setExpanded(root, true);
    openProject(root);
    newTask(root);
  };

  const endDrag = () => {
    setDragIndex(undefined);
    setOverIndex(undefined);
  };

  // 逐项目派生只随数据变化重算——拖拽指示/展开/菜单这类纯 UI 状态翻动时零重算。
  const groups = useMemo(
    () =>
      roots
        .map((root, index) => ({
          root,
          index,
          tasks: projectTasks(live, root, query, pinned),
        }))
        .filter((group) => !searching || group.tasks.length > 0),
    [roots, live, query, pinned, searching],
  );

  if (unsupported) return <EmptyTree messageKey="sidebar.unsupported" />;
  if (roots.length === 0) return <EmptyTree messageKey="home.noProjects" />;
  if (searching && groups.length === 0) return <EmptyTree messageKey="sidebar.noMatch" />;

  return (
    <div className="project-tree">
      {groups.map(({ root, index, tasks }) => {
        const open = searching || isExpanded(root);
        const active = root === currentRoot;
        const all = searching || showAll[root] === true;
        const shown = all ? tasks : tasks.slice(0, TASK_PREVIEW_COUNT);
        const overClass =
          overIndex === index && dragIndex !== undefined && dragIndex !== index
            ? dragIndex > index
              ? ' project-row-over-top'
              : ' project-row-over-bottom'
            : '';
        return (
          <div key={root} className="project-group">
            <div
              className={`project-row${active ? ' project-row-active' : ''}${
                dragIndex === index ? ' project-row-dragging' : ''
              }${overClass}`}
              role="button"
              tabIndex={0}
              title={root}
              draggable
              onClick={() => pickProject(root)}
              onContextMenu={(e) => {
                e.preventDefault();
                setProjMenu({ root, x: e.clientX, y: e.clientY });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') pickProject(root);
              }}
              onDragStart={() => setDragIndex(index)}
              onDragOver={(e) => {
                e.preventDefault();
                if (overIndex !== index) setOverIndex(index);
              }}
              onDrop={(e) => {
                e.preventDefault();
                // dragIndex 是 roots 空间下标(roots.map 产出);搜索会过滤 groups
                // 造成两个下标空间错位,取源项目必须回 roots。
                const from = dragIndex !== undefined ? roots[dragIndex] : undefined;
                if (from !== undefined && from !== root) move(from, root);
                endDrag();
              }}
              onDragEnd={endDrag}
            >
              <button
                type="button"
                className="project-caret"
                tabIndex={-1}
                aria-label={open ? t('sidebar.collapseProject') : t('sidebar.expandProject')}
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(root, !isExpanded(root));
                }}
              >
                {open ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}
              </button>
              <span className="project-row-icon">
                {open ? <FolderOpenIcon size={15} /> : <FolderSimpleIcon size={15} />}
              </span>
              <span className="project-row-name">{projectName(root)}</span>
              <button
                type="button"
                className="project-row-new"
                title={t('sidebar.newSession')}
                onClick={(e) => {
                  e.stopPropagation();
                  newSessionIn(root);
                }}
              >
                <ChatTeardropDotsIcon size={13} />
              </button>
            </div>
            {open ? (
              <div className="project-tasks">
                {tasks.length === 0 ? (
                  <div className="sidebar-empty">{t('sidebar.noTasks')}</div>
                ) : (
                  shown.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      active={task.id === activeTaskId}
                      pinned={pinned.includes(task.id)}
                      onContextMenu={onContextMenu}
                    />
                  ))
                )}
                {!searching && tasks.length > TASK_PREVIEW_COUNT ? (
                  <button
                    type="button"
                    className="project-more-row"
                    onClick={() => setShowAll(root, !all)}
                  >
                    {all ? <CaretUpIcon size={12} /> : <DotsThreeIcon size={13} />}
                    {all
                      ? t('sidebar.collapseMore')
                      : t('sidebar.showMore', { n: String(tasks.length - TASK_PREVIEW_COUNT) })}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {projMenu ? (
        <ContextMenu
          x={projMenu.x}
          y={projMenu.y}
          title={projMenu.root}
          items={[
            { id: 'new', label: t('ctxMenu.newSession'), icon: <PlusIcon size={14} /> },
            {
              id: 'remove',
              label: t('sidebar.removeProject'),
              icon: <MinusCircleIcon size={14} />,
              separatorBefore: true,
            },
          ]}
          onPick={(id) => {
            if (id === 'new') newSessionIn(projMenu.root);
            // 移出只删列表项(localStorage),不动磁盘——projectsStore 语义。
            if (id === 'remove') removeProject(projMenu.root);
          }}
          onClose={() => setProjMenu(undefined)}
        />
      ) : null}
    </div>
  );
}
