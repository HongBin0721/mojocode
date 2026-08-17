/**
 * 手动管理的项目文件夹列表(ZCode 侧栏「项目」的数据源):用户经「+ 添加
 * 项目」的原生目录选择器加入,打开过的工作区 root 也会自动入列(Sidebar
 * 的 effect),localStorage 持久化——仅是 GUI 本机偏好,移除只从列表消失,
 * 不动磁盘。纯函数(解析/增删)在 utils/projects.ts,此处只做 zustand 接线。
 */

import { create } from 'zustand';
import { addProject, loadProjects, removeProject } from '../utils/projects.js';
import { readLocal, writeLocal } from '../utils/host.js';

const STORAGE_KEY = 'mojocode.projects';

export interface ProjectsStore {
  projects: string[];
  add(root: string): void;
  remove(root: string): void;
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
  add: (root) => apply(set, get().projects, addProject(get().projects, root)),
  remove: (root) => apply(set, get().projects, removeProject(get().projects, root)),
}));
