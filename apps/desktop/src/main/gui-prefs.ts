/**
 * GUI 本机偏好落盘(~/.mojocode/gui.json):项目列表、语言、字号、侧栏宽度
 * 等「localStorage 形状」的字符串键值(序列化/解析语义仍在各调用点)。
 *
 * 为什么不用 renderer 的 localStorage:它的落盘位置 = userData 目录 × 页面
 * origin,dev(localhost)与构建产物(file://)天然分家,启动方式一变
 * userData 目录还可能再换一次——偏好跟着启动方式漂移(项目列表"消失"的
 * 事故来源)。统一落到 ~/.mojocode/ 与 CLI 配置同家,和 origin 彻底解耦。
 *
 * 本模块保持 electron-free(ipcMain 接线在 main/index.ts),Node 测试直读。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 与核心 src/config/paths.ts 同口径:$HOME 优先于 os.homedir()。 */
function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

export function guiPrefsFile(): string {
  return join(homeDir(), '.mojocode', 'gui.json');
}

/** 容错解析 JSON 对象为同值类型 Record:坏 JSON/非对象回 {},不合格条目丢弃。 */
function parseRecord<T>(text: string, isValue: (value: unknown) => value is T): Record<string, T> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, T> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isValue(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** 读盘:不存在/坏 JSON/非对象一律回 {},非字符串值丢弃——偏好坏了不能挡启动。 */
export function loadGuiPrefs(file: string): Record<string, string> {
  try {
    return parseRecord(readFileSync(file, 'utf8'), (v): v is string => typeof v === 'string');
  } catch {
    return {};
  }
}

export interface GuiPrefs {
  snapshot(): Record<string, string>;
  set(key: string, value: string): void;
  /** 退出路径兜底:把去抖窗口内的待写立即落盘。 */
  flush(): void;
}

/**
 * 任务「已看状态」的持久化(会话 id → 用户最后看过的消息数,1:1)。
 * 归属是 main 的 TaskManager(任务列表与聚焦态的唯一拥有者);本 store 只
 * 负责 gui.json 一个键上的 JSON 编解码,读写走 GuiPrefs(去抖 + 原子写)。
 */
export interface ViewedTasksStore {
  load(): Record<string, number>;
  save(map: Record<string, number>): void;
}

const VIEWED_TASKS_KEY = 'viewedTasks';

export function createViewedTasksStore(prefs: GuiPrefs): ViewedTasksStore {
  return {
    /** 坏 JSON/非对象/非数值条目一律丢弃——偏好坏了不能挡任务列表。 */
    load: () =>
      parseRecord(
        prefs.snapshot()[VIEWED_TASKS_KEY] ?? '',
        (v): v is number => typeof v === 'number' && Number.isFinite(v),
      ),
    save: (map) => prefs.set(VIEWED_TASKS_KEY, JSON.stringify(map)),
  };
}

/**
 * 写入去抖 200ms:侧栏/面板拖拽是逐 mousemove 的 writeLocal,不能每次都碰盘。
 * 窗口内的连续 set 合并为一次写;写入走 tmp + rename 原子替换,半截 JSON
 * 不落盘。所有失败静默——与 renderer writeLocal 同约定,持久化不影响本次会话。
 */
export function createGuiPrefs(file = guiPrefsFile()): GuiPrefs {
  const prefs = loadGuiPrefs(file);
  let timer: NodeJS.Timeout | undefined;
  const write = (): void => {
    timer = undefined;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`);
      renameSync(tmp, file);
    } catch {
      // 静默:磁盘/权限问题不挡会话。
    }
  };
  return {
    snapshot: () => ({ ...prefs }),
    set: (key, value) => {
      // IPC 入参不可信,这里是类型闸门(renderer 被攻破也写不进非字符串)。
      if (typeof key !== 'string' || typeof value !== 'string') return;
      prefs[key] = value;
      if (timer === undefined) timer = setTimeout(write, 200);
    },
    flush: () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      write();
    },
  };
}
