/**
 * 扩展渲染层在 TUI 侧的两件小工具:给扩展上色的主题面(返回带 SGR 的
 * 字符串,kit 的 Text 会解析),以及把 kit 的按键解析结果还原成 Pi 风格的
 * 原始序列——Pi 的组件习惯直接比对 `data === '\\x1b'` / `'\\r'`。
 */

import { normalizeShortcut, type ExtensionTheme, type ExtensionKey } from '../core/extension-types.js';

const FG: Record<Parameters<ExtensionTheme['fg']>[0], string> = {
  accent: '36',
  dim: '90',
  error: '31',
  warn: '33',
  success: '32',
  text: '39',
};

const wrap = (open: string, close: string, text: string): string =>
  text ? `\x1b[${open}m${text}\x1b[${close}m` : text;

export const extensionTheme: ExtensionTheme = {
  fg: (name, text) => wrap(FG[name], '39', text),
  bold: (text) => wrap('1', '22', text),
  dim: (text) => wrap('2', '22', text),
  italic: (text) => wrap('3', '23', text),
};

/** kit 的 (input, key) → Pi 风格的原始按键序列。可打印字符与粘贴原样。 */
export function keyToData(input: string, key: ExtensionKey): string {
  if (key.escape) return '\x1b';
  if (key.return) return '\r';
  if (key.tab) return key.shift ? '\x1b[Z' : '\t';
  if (key.backspace) return '\x7f';
  if (key.delete) return '\x1b[3~';
  if (key.upArrow) return '\x1b[A';
  if (key.downArrow) return '\x1b[B';
  if (key.rightArrow) return '\x1b[C';
  if (key.leftArrow) return '\x1b[D';
  if (key.pageUp) return '\x1b[5~';
  if (key.pageDown) return '\x1b[6~';
  if (key.ctrl && input.length === 1) {
    const code = input.toLowerCase().charCodeAt(0) - 96;
    if (code >= 1 && code <= 26) return String.fromCharCode(code);
  }
  return input;
}

/** 具名键 → 快捷键里的写法。与 keyToData 的分支同源,一张表说清。 */
const NAMED_KEYS: ReadonlyArray<[keyof ExtensionKey, string]> = [
  ['upArrow', 'up'],
  ['downArrow', 'down'],
  ['leftArrow', 'left'],
  ['rightArrow', 'right'],
  ['pageUp', 'pageup'],
  ['pageDown', 'pagedown'],
  ['return', 'return'],
  ['escape', 'escape'],
  ['tab', 'tab'],
  ['backspace', 'backspace'],
  ['delete', 'delete'],
];

/** kit 的 (input, key) → normalizeShortcut 形态的组合键名(`ctrl+g`、`meta+shift+k`)。 */
export function shortcutOf(input: string, key: ExtensionKey): string {
  const name = NAMED_KEYS.find(([flag]) => key[flag])?.[1] ?? input.toLowerCase();
  return normalizeShortcut(
    [key.ctrl ? 'ctrl' : '', key.meta ? 'meta' : '', key.shift ? 'shift' : '', name].filter(Boolean).join('+'),
  );
}
