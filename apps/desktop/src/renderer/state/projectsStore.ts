/**
 * 手动管理的项目文件夹列表(ZCode 侧栏「项目」的数据源):用户经「+ 添加
 * 项目」的原生目录选择器加入,打开过的工作区 root 也会自动入列(Sidebar
 * 的 effect),localStorage 持久化——仅是 GUI 本机偏好,移除只从列表消失,
 * 不动磁盘。纯函数(解析/增删)在 utils/projects.ts,此处只做 zustand 接线。
 */

import { create } from 'zustand';
import { addProject, loadProjects, moveProject, removeProject } from '../utils/projects.js';
import { readLocal, writeLocal } from '../utils/host.js';

const STORAGE_KEY = 'mojocode.projects';
const SELECTED_KEY = 'mojocode.selectedProject';
const PINNED_KEY = 'mojocode.pinnedTasks';

export interface ProjectsStore {
  projects: string[];
  /** 侧栏当前查看的项目(过滤视角;新任务落这个 root)。null = 跟随聚焦任务。 */
  selected: string | null;
  /** 置顶的任务 id(右键菜单「置顶」;排序时前置)。 */
  pinned: string[];
  add(root: string): void;
  remove(root: string): void;
  /**
   * 拖拽排序:projects 数组本身就是展示顺序。按 root 定位而非下标——调用方
   * (ProjectTree)展示的列表可能含兜底并入项,下标空间与 store 不保证一致。
   */
  move(fromRoot: string, toRoot: string): void;
  select(root: string): void;
  togglePin(taskId: string): void;
}

/** 增删共用:纯函数没产生变化(同引用)就不落盘、不唤醒订阅者。 */
function apply(
  set: (partial: Partial<ProjectsStore>) => void,
  prev: string[],
  next: string[],
): void {
  if (next === prev) return;
  writeLocal(STORAGE_KEY, JSON.stringify(next));
  set({ projects: next });
}

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
  projects: loadProjects(readLocal(STORAGE_KEY)),
  selected: readLocal(SELECTED_KEY) || null,
  pinned: loadProjects(readLocal(PINNED_KEY)),
  add: (root) => apply(set, get().projects, addProject(get().projects, root)),
  move: (fromRoot, toRoot) => {
    const list = get().projects;
    // 未入列的兜底项(indexOf = -1)由 moveProject 的越界守卫原样返回。
    apply(set, list, moveProject(list, list.indexOf(fromRoot), list.indexOf(toRoot)));
  },
  remove: (root) => {
    apply(set, get().projects, removeProject(get().projects, root));
    if (get().selected === root) {
      writeLocal(SELECTED_KEY, '');
      set({ selected: null });
    }
  },
  select: (root) => {
    writeLocal(SELECTED_KEY, root);
    set({ selected: root });
  },
  togglePin: (taskId) => {
    const prev = get().pinned;
    const next = prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId];
    writeLocal(PINNED_KEY, JSON.stringify(next));
    set({ pinned: next });
  },
}));
