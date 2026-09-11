/**
 * 主题文件(Pi 的 themes):`<name>.json`,形状
 *
 *   { "name": "dusk", "colors": { "accent": "#7aa2f7", "dim": "gray", … } }
 *
 * `colors` 的键见 theme.ts 的 THEME_COLOR_KEYS,值是 kit 认的颜色(命名色或
 * `#rrggbb`);没写的键保留内置配色。查找顺序:项目 `.mojocode/themes/` >
 * `~/.mojocode/themes/` > 包与扩展贡献的目录(resources_discover 的
 * themePaths)。启动时在 render 之前应用一次(tui.tsx 的 runTui);运行期
 * `/theme <name>` 再换:`applyTheme` 只改这一张表并 bump 版本信号,JSX 里读
 * `theme.x` 的节点自己重算(选择器的预览靠这个,不重挂);提交后 App 仍整树
 * 重挂兜底——扩展自拼的 SGR 行、一次性算好的字符串不走 JSX。
 * 找不到或解析失败都不拦启动——回落内置配色并返回原因,由调用方提示。
 *
 * `default` 是保留名:代表内置配色,不查磁盘(同名的主题文件会被遮住)。
 */

import { watch, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { globalThemesDir, projectThemesDir } from '../config/paths.js';
import { BUILTIN_PALETTE, palette, THEME_COLOR_KEYS, type ThemeColorKey } from '../core/palette.js';
import { bumpTheme } from './theme.js';

/** `/theme` 里代表内置配色的保留名。 */
export const BUILTIN_THEME_NAME = 'default';

export type ThemeColors = Partial<Record<ThemeColorKey, string>>;

export interface LoadedTheme {
  name: string;
  file: string;
  colors: ThemeColors;
}

export type ThemeLoadResult =
  | { ok: true; theme: LoadedTheme }
  | { ok: false; reason: 'not-found' | 'invalid'; detail?: string };

/** 主题目录,优先级从高到低。 */
export function themeLocations(root: string, extraDirs: readonly string[] = []): string[] {
  return [projectThemesDir(root), globalThemesDir(), ...extraDirs];
}

/**
 * 列出各目录里可选的主题名(`<name>.json` 去掉后缀),按目录优先级去重——
 * 同名时高优先级目录的赢,与 loadTheme 的取法一致。不解析文件:坏文件
 * 也列出来,选中时 loadTheme 会报 invalid,比在列表里悄悄消失更好查。
 * 保留名 `default` 不列(调用方自己加,它不在磁盘上)。
 */
export async function listThemes(dirs: readonly string[]): Promise<Array<{ name: string; file: string }>> {
  const seen = new Map<string, string>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue;
      const name = entry.slice(0, -'.json'.length);
      if (!name || name === BUILTIN_THEME_NAME || seen.has(name)) continue;
      seen.set(name, path.join(dir, entry));
    }
  }
  return [...seen].map(([name, file]) => ({ name, file }));
}

/** 解析主题 JSON 的 `colors` 段:只收已知键、字符串值,其余静默丢掉。 */
export function parseThemeColors(raw: unknown): ThemeColors | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const colors = (raw as { colors?: unknown }).colors;
  if (!colors || typeof colors !== 'object') return undefined;
  const out: ThemeColors = {};
  for (const key of THEME_COLOR_KEYS) {
    const value = (colors as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}

/** 按名字在目录里找 `<name>.json` 并解析;第一个命中的目录赢。 */
export async function loadTheme(name: string, dirs: readonly string[]): Promise<ThemeLoadResult> {
  for (const dir of dirs) {
    const file = path.join(dir, `${name}.json`);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { ok: false, reason: 'invalid', detail: `${file}: ${(err as Error).message}` };
    }
    const colors = parseThemeColors(parsed);
    if (!colors) return { ok: false, reason: 'invalid', detail: `${file}: missing "colors"` };
    return { ok: true, theme: { name, file, colors } };
  }
  return { ok: false, reason: 'not-found' };
}

/**
 * 就地覆盖配色表:给了的键取主题值,没给的键回到内置配色;返回被改掉的键数。
 * 改的是 `core/palette.ts` 那**一张**表,TUI 的组件与扩展的 `ExtensionTheme`
 * 因此一起变色;有改动就 bump 版本,JSX 里读过 `theme.x` 的节点跟着重算。
 * 传空对象即回到内置配色(`/theme default`)。
 */
export function applyTheme(colors: ThemeColors): number {
  let changed = 0;
  for (const key of THEME_COLOR_KEYS) {
    const value = colors[key] ?? BUILTIN_PALETTE[key];
    if (palette[key] !== value) {
      palette[key] = value;
      changed += 1;
    }
  }
  if (changed > 0) bumpTheme();
  return changed;
}

/** 编辑器保存一次常触发多个事件(截断 + 写入、或改名替换),合并到一次回调。 */
const WATCH_DEBOUNCE_MS = 100;

/**
 * 盯住一个主题文件,内容变了就回调(热重载:改着主题文件看效果,不必再敲
 * `/theme`)。盯的是所在目录而不是文件本身:编辑器多半是写临时文件再改名
 * 顶上,直接盯文件会在第一次保存后失效。目录盯不上(不存在、平台不支持)
 * 就静默放弃——热重载是锦上添花,不能因此拦住换主题。返回停止函数。
 */
export function watchThemeFile(file: string, onChange: () => void): () => void {
  const base = path.basename(file);
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(path.dirname(file), (_event, name) => {
      if (name !== null && name !== base) return;
      clearTimeout(timer);
      timer = setTimeout(onChange, WATCH_DEBOUNCE_MS);
    });
    // 目录被删、权限变化之类的错误异步冒出来;不处理会变成未捕获异常掀掉 TUI。
    watcher.on('error', () => watcher?.close());
  } catch {
    return () => {};
  }
  return () => {
    clearTimeout(timer);
    watcher?.close();
  };
}
