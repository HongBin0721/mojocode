/**
 * 给扩展作者的两个现成组件(Pi 生态里 pi-tui 的 SelectList / 文本输入的
 * 对应物):都是 Pi 形状的 ExtensionComponent 工厂,配 `ctx.ui.custom` 用——
 * 自己拼行的扩展不必再各写一遍光标与退格。零依赖、Node-free,随
 * `mojocode/extension` 一起导出。
 */

import type { ComponentFactory, ExtensionComponent, ComponentHost } from './extension-types.js';
import { t } from '../i18n/index.js';

/**
 * 围绕光标居中的窗口起点。**所有窗口化列表共用这一份**(TUI 的选择器经
 * `ui/picker-utils.tsx` 再导出),滚动手感才是同一个:光标尽量居中,列表
 * 两端各自贴边。住在这里而不是 picker-utils:那边 import 了 solid 与 kit,
 * 而这个模块要保持零依赖(它随 `mojocode/extension` 发给扩展作者)。
 */
export function centeredWindowStart(cursor: number, rowCount: number, window: number): number {
  return Math.max(0, Math.min(cursor - Math.floor(window / 2), rowCount - window));
}

export interface SelectListOptions<T> {
  items: readonly T[];
  /** 每项怎么画;缺省 String(item)。 */
  label?: (item: T) => string;
  title?: string;
  /** 一屏最多几行,超出按光标滚动。 */
  window?: number;
  onSelect: (item: T, index: number) => void;
  /** esc;缺省什么都不做(交给调用方在 custom 的 done 里处理)。 */
  onCancel?: () => void;
}

/** ↑/↓ 移动(回绕)、回车选中、esc 取消的列表。 */
export function selectList<T>(options: SelectListOptions<T>): ComponentFactory {
  return (host: ComponentHost): ExtensionComponent => {
    const label = options.label ?? ((item: T) => String(item));
    const window = Math.max(1, options.window ?? 8);
    let cursor = 0;
    return {
      render: (width) => {
        const count = options.items.length;
        const start = centeredWindowStart(cursor, count, window);
        const rows: string[] = [];
        if (options.title) rows.push(host.theme.bold(options.title));
        // 与 TUI 的选择器同一句文案:扩展画的列表不该是界面里唯一不翻译的地方。
        if (start > 0) rows.push(host.theme.dim(t('selector.moreAbove', { n: start })));
        options.items.slice(start, start + window).forEach((item, i) => {
          const index = start + i;
          const text = `${index === cursor ? '❯ ' : '  '}${label(item)}`.slice(0, width);
          rows.push(index === cursor ? host.theme.fg('accent', text) : text);
        });
        const rest = count - start - window;
        if (rest > 0) rows.push(host.theme.dim(t('selector.moreBelow', { n: rest })));
        return rows;
      },
      handleInput: (_data, key) => {
        const count = options.items.length;
        if (key.escape) {
          options.onCancel?.();
          return;
        }
        if (count === 0) return;
        if (key.upArrow) cursor = (cursor - 1 + count) % count;
        else if (key.downArrow) cursor = (cursor + 1) % count;
        else if (key.return) options.onSelect(options.items[cursor]!, cursor);
        host.requestRender();
      },
    };
  };
}

export interface TextInputOptions {
  title?: string;
  placeholder?: string;
  initial?: string;
  onSubmit: (text: string) => void;
  onCancel?: () => void;
}

/** 一行文本:可打印字符追加、退格删一个、回车提交、esc 取消。 */
export function textInput(options: TextInputOptions): ComponentFactory {
  return (host: ComponentHost): ExtensionComponent => {
    let value = options.initial ?? '';
    return {
      render: (width) => {
        const rows: string[] = [];
        if (options.title) rows.push(host.theme.bold(options.title));
        const body = value || host.theme.dim(options.placeholder ?? '');
        rows.push(`${host.theme.fg('accent', '❯ ')}${body}${host.theme.fg('accent', '▏')}`.slice(0, width + 40));
        return rows;
      },
      handleInput: (data, key) => {
        if (key.escape) {
          options.onCancel?.();
          return;
        }
        if (key.return) {
          options.onSubmit(value);
          return;
        }
        // 与 TUI 的 applyTextKey 同一套语义(那边住在 ui/picker-utils,这个
        // 模块要保持零依赖,所以是同规则的两行而不是同一个函数)。
        if (key.backspace || key.delete) value = value.slice(0, -1);
        else if (!key.ctrl && !key.meta && data && !data.startsWith('\x1b')) {
          value += data.replace(/[\r\n]/g, '');
        }
        host.requestRender();
      },
    };
  };
}
