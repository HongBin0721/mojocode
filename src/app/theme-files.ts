/**
 * 主题文件的查找与解析(Pi 的 themes):`<name>.json`,形状
 *
 *   { "name": "dusk", "colors": { "accent": "#7aa2f7", "dim": "gray", … } }
 *
 * `colors` 的键见 core/palette.ts 的 THEME_COLOR_KEYS,值是 kit 认的颜色(命名
 * 色或 `#rrggbb`);没写的键保留内置配色。查找顺序:项目 `.mojocode/themes/` >
 * `~/.mojocode/themes/` > 包与扩展贡献的目录(resources_discover 的 themePaths)。
 *
 * 只管**文件**,不管**上色**:上色是 `core/palette.ts` 的 `applyPalette`,让
 * TUI 重算是 `ui/theme-loader.ts` 的 `applyTheme`。拆成这三层是被扩展的
 * `ui.getAllThemes / getTheme / setTheme` 逼出来的——它们由 bootstrap 实现,
 * 而 bootstrap 在 `-p` 那条不带 FFI、不带 solid-js 的路上,import 不了
 * `src/ui/`;ui/theme-loader.ts 原样 re-export 这里的东西,TUI 侧的调用方
 * 一个都不用改。
 *
 * `default` 是保留名:代表内置配色,不查磁盘(同名的主题文件会被遮住)。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { globalThemesDir, projectThemesDir } from '../config/paths.js';
import { BUILTIN_PALETTE, THEME_COLOR_KEYS, type ThemeColors } from '../core/palette.js';

export type { ThemeColors };

/** `/theme` 里代表内置配色的保留名。 */
export const BUILTIN_THEME_NAME = 'default';

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

/**
 * 可选的全部主题:内置的 `default`(没有文件)排第一,其后是各目录里的
 * `<name>.json`。`/theme` 的用法提示、选择器与扩展的 `ui.getAllThemes` 共用——
 * 「default 是保留名、排第一」只在这里写一次。
 */
export async function listAllThemes(
  dirs: readonly string[],
): Promise<Array<{ name: string; file: string | undefined }>> {
  return [{ name: BUILTIN_THEME_NAME, file: undefined }, ...(await listThemes(dirs))];
}

/**
 * 按名字解析成一套配色:`default` 是内置配色(不查磁盘,没有文件可盯),其余
 * 走 loadTheme。`/theme`、选择器预览、扩展的 `ui.getTheme / setTheme` 共用——
 * 各写一遍「default 还是查盘」的分支时,保留名的规则要在四处各记一次。
 */
export async function resolveTheme(
  name: string,
  dirs: readonly string[],
): Promise<
  | { ok: true; colors: ThemeColors; file: string | undefined }
  | { ok: false; reason: 'not-found' | 'invalid'; detail?: string }
> {
  if (name === BUILTIN_THEME_NAME) return { ok: true, colors: { ...BUILTIN_PALETTE }, file: undefined };
  const result = await loadTheme(name, dirs);
  return result.ok ? { ok: true, colors: result.theme.colors, file: result.theme.file } : result;
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
