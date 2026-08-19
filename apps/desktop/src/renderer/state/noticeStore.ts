/**
 * 全局轻提示(toast):上行 RPC 失败的统一出口。timeline 的 notice 条目
 * 不够用——ArchiveView/HomeView 这类无时间线的视图也会发 RPC,失败得有个
 * 用户看得见的去处(此前是 12 个文件各自 console.error,错误全部静默)。
 * 上限 3 条丢最旧,5s 自动消失;pushNotice 是非 React 侧(invoke 层)的入口。
 */

import { create } from 'zustand';

export interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

const MAX_NOTICES = 3;
const AUTO_DISMISS_MS = 5000;

interface NoticeStore {
  notices: Notice[];
  push(level: Notice['level'], message: string): void;
  dismiss(id: number): void;
}

let nextId = 1;

export const useNoticeStore = create<NoticeStore>((set) => ({
  notices: [],

  push: (level, message) => {
    const id = nextId++;
    set((state) => {
      const merged = [...state.notices, { id, level, message }];
      return { notices: merged.slice(-MAX_NOTICES) };
    });
    // 自动消失:已被容量淘汰/手动关掉的 id 过滤后是 no-op。
    setTimeout(() => {
      set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }));
    }, AUTO_DISMISS_MS);
  },

  dismiss: (id) =>
    set((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) })),
}));

/** 非 React 侧入口(invoke 层/actions 用)。 */
export function pushNotice(level: Notice['level'], message: string): void {
  useNoticeStore.getState().push(level, message);
}
