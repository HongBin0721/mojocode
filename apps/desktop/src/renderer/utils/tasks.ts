/**
 * 任务列表派生的纯函数:同一口径此前在 Sidebar/HomeView/ArchiveView 逐字
 * 重复了三份(「空会话不进列表」这类产品语义散在三处,改一处漏两处)。
 * 组件侧继续用 useMemo 按自己的依赖粒度缓存,这里只保证口径唯一。
 */

import type { TaskSummary } from '../../shared/ipc.js';

/**
 * 未归档且已有真实内容(messageCount > 0)的任务。空会话不进列表(聚焦中
 * 的也不例外):新建任务先开聊天视图,首条消息落地后行才出现(对齐 Codex)。
 */
export function liveTasks(tasks: TaskSummary[] | undefined): TaskSummary[] {
  return (tasks ?? []).filter((task) => !task.archivedAt && task.messageCount > 0);
}

/**
 * 当前项目的任务:root 过滤 + 标题包含/ID 前缀搜索 + 置顶前置。置顶内与
 * 未置顶内都保持入参顺序(tasks 通道已按 updatedAt 倒序推送)。
 */
export function projectTasks(
  live: TaskSummary[],
  root: string | undefined,
  query: string,
  pinned: readonly string[],
): TaskSummary[] {
  const list = live.filter((task) => task.root === root);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? list.filter(
        (task) => task.title.toLowerCase().includes(q) || task.id.toLowerCase().startsWith(q),
      )
    : list;
  const pinnedSet = new Set(pinned);
  return [
    ...filtered.filter((task) => pinnedSet.has(task.id)),
    ...filtered.filter((task) => !pinnedSet.has(task.id)),
  ];
}

/** 归档列表:archivedAt 非空,按归档时间倒序。 */
export function archivedTasks(tasks: TaskSummary[] | undefined): TaskSummary[] {
  return (tasks ?? [])
    .filter((task) => task.archivedAt)
    .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));
}
