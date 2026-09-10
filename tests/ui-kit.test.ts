import { describe, expect, it } from 'vitest';
import { selectList, textInput } from '../src/core/ui-kit.js';
import type { ComponentHost, ExtensionKey } from '../src/core/extension-types.js';

/** 给扩展作者的两个组件工厂:纯逻辑,不需要 TUI。 */
const host = (): ComponentHost & { renders: number } => {
  const h = {
    renders: 0,
    width: 40,
    requestRender: () => {
      h.renders += 1;
    },
    theme: {
      fg: (_n: string, t: string) => t,
      bold: (t: string) => t,
      dim: (t: string) => t,
      italic: (t: string) => t,
    },
  };
  return h;
};
const key = (over: Partial<ExtensionKey> = {}): ExtensionKey => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageUp: false,
  pageDown: false,
  return: false,
  escape: false,
  tab: false,
  backspace: false,
  delete: false,
  ctrl: false,
  shift: false,
  meta: false,
  ...over,
});

describe('selectList', () => {
  it('↑/↓ 回绕、回车选中、esc 取消、窗口滚动', () => {
    const picked: Array<[string, number]> = [];
    let cancelled = 0;
    const h = host();
    const c = selectList({
      items: ['a', 'b', 'c', 'd'],
      window: 2,
      title: 'T',
      onSelect: (item, i) => picked.push([item, i]),
      onCancel: () => cancelled++,
    })(h);
    expect(c.render(40)).toEqual(['T', '❯ a', '  b', '… 2 more below']);
    c.handleInput!('\x1b[A', key({ upArrow: true }));
    expect(c.render(40)).toEqual(['T', '… 2 more above', '  c', '❯ d']);
    c.handleInput!('\x1b[B', key({ downArrow: true }));
    c.handleInput!('\r', key({ return: true }));
    expect(picked).toEqual([['a', 0]]);
    c.handleInput!('\x1b', key({ escape: true }));
    expect(cancelled).toBe(1);
    expect(h.renders).toBe(3);
  });
});

describe('textInput', () => {
  it('打字、退格、回车提交、esc 取消,占位符只在空时显示', () => {
    const submitted: string[] = [];
    let cancelled = 0;
    const h = host();
    const c = textInput({ placeholder: 'name?', onSubmit: (t) => submitted.push(t), onCancel: () => cancelled++ })(h);
    expect(c.render(40)[0]).toContain('name?');
    c.handleInput!('hi', key());
    c.handleInput!('!', key());
    c.handleInput!('\x7f', key({ backspace: true }));
    expect(c.render(40)[0]).toContain('hi');
    expect(c.render(40)[0]).not.toContain('name?');
    c.handleInput!('\x1b[A', key({ upArrow: true })); // 方向键序列不进文本
    c.handleInput!('\r', key({ return: true }));
    expect(submitted).toEqual(['hi']);
    c.handleInput!('\x1b', key({ escape: true }));
    expect(cancelled).toBe(1);
  });
});
