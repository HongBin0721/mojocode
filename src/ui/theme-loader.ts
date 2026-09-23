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
import path from 'node:path';
import { applyPalette, type ThemeColors } from '../core/palette.js';
import { bumpTheme } from './theme.js';

// 文件的查找与解析搬去了 app/theme-files.ts(理由见那边的文件头:扩展的
// `ui.getAllThemes / getTheme / setTheme` 由 bootstrap 实现,而它 import 不了
// src/ui/)。这里原样 re-export,TUI 侧的调用方一个都不用改。
export {
  BUILTIN_THEME_NAME,
  listAllThemes,
  listThemes,
  loadTheme,
  resolveTheme,
  parseThemeColors,
  themeLocations,
  type LoadedTheme,
  type ThemeColors,
  type ThemeLoadResult,
} from '../app/theme-files.js';

/**
 * 就地覆盖配色表并让 TUI 重算:`applyPalette` 改 `core/palette.ts` 那**一张**表
 * (给了的键取主题值,没给的回内置配色),有改动就 bump 版本,JSX 里读过
 * `theme.x` 的节点跟着重算。传空对象即回到内置配色(`/theme default`)。
 * 返回被改掉的键数。
 */
export function applyTheme(colors: ThemeColors): number {
  const changed = applyPalette(colors);
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
