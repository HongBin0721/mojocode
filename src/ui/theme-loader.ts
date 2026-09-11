/**
 * 主题文件(Pi 的 themes):`<name>.json`,形状
 *
 *   { "name": "dusk", "colors": { "accent": "#7aa2f7", "dim": "gray", … } }
 *
 * `colors` 的键见 theme.ts 的 THEME_COLOR_KEYS,值是 kit 认的颜色(命名色或
 * `#rrggbb`);没写的键保留内置配色。查找顺序:项目 `.mojocode/themes/` >
 * `~/.mojocode/themes/` > 包与扩展贡献的目录(resources_discover 的
 * themePaths)。**只在 render 之前应用一次**(tui.tsx 的 runTui):渲染代码
 * 现读 theme 对象,但已经画出来的静态行不会因换色重画,运行期不提供切换。
 * 找不到或解析失败都不拦启动——回落内置配色并返回原因,由调用方提示。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { globalThemesDir, projectThemesDir } from '../config/paths.js';
import { palette, THEME_COLOR_KEYS, type ThemeColorKey } from '../core/palette.js';

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
 * 就地覆盖配色表;返回被改掉的键数。改的是 `core/palette.ts` 那**一张**表,
 * TUI 的组件与扩展的 `ExtensionTheme` 因此一起变色。
 */
export function applyTheme(colors: ThemeColors): number {
  let changed = 0;
  for (const key of THEME_COLOR_KEYS) {
    const value = colors[key];
    if (value !== undefined && palette[key] !== value) {
      palette[key] = value;
      changed += 1;
    }
  }
  return changed;
}
