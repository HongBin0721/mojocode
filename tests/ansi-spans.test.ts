import { describe, expect, it } from 'vitest';
import { hasAnsi, parseAnsiSpans } from '../src/ui/ansi-spans.js';

describe('ansi-spans', () => {
  it('无 ANSI 文本得到单段原文', () => {
    expect(parseAnsiSpans('plain 中文')).toEqual([{ text: 'plain 中文' }]);
    expect(hasAnsi('plain')).toBe(false);
    expect(hasAnsi('\x1b[31mx')).toBe(true);
  });

  it('16 色前景与重置', () => {
    const spans = parseAnsiSpans('\x1b[31mred\x1b[39m rest');
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ text: 'red', fg: '#cd3131' });
    // 39 重置为继承外层:fg 字段不存在
    expect(spans[1]?.text).toBe(' rest');
    expect(spans[1]?.fg).toBeUndefined();
  });

  it('亮色 90-97 与背景 40-47/100-107', () => {
    const spans = parseAnsiSpans('\x1b[92mA\x1b[41mB\x1b[49mC');
    expect(spans[0]).toMatchObject({ text: 'A', fg: '#23d18b' });
    expect(spans[1]).toMatchObject({ text: 'B', fg: '#23d18b', bg: '#cd3131' });
    expect(spans[2]?.bg).toBeUndefined();
  });

  it('256 色与真彩色', () => {
    const spans = parseAnsiSpans('\x1b[38;5;196mX\x1b[48;2;30;64;35mY');
    expect(spans[0]?.fg).toBe('#ff0000'); // 196 = 立方 (5,0,0)
    expect(spans[1]?.bg).toBe('#1e4023'); // diffAddedBg 的真彩写法
  });

  it('灰阶 232-255', () => {
    const spans = parseAnsiSpans('\x1b[38;5;232mA\x1b[38;5;255mB');
    expect(spans[0]?.fg).toBe('#080808');
    expect(spans[1]?.fg).toBe('#eeeeee');
  });

  it('属性开与关(bold/dim/italic/underline/inverse/strike)', () => {
    const spans = parseAnsiSpans('\x1b[1;3mA\x1b[22;23mB\x1b[7mC\x1b[27m\x1b[9mD');
    expect(spans[0]).toMatchObject({ text: 'A', bold: true, italic: true });
    expect(spans[1]?.bold).toBeUndefined();
    expect(spans[1]?.italic).toBeUndefined();
    expect(spans[2]).toMatchObject({ text: 'C', inverse: true });
    expect(spans[3]).toMatchObject({ text: 'D', strikethrough: true });
    expect(spans[3]?.inverse).toBeUndefined();
  });

  it('SGR 0 全量重置', () => {
    const spans = parseAnsiSpans('\x1b[1;31;44mA\x1b[0mB');
    expect(spans[0]).toMatchObject({ bold: true, fg: '#cd3131', bg: '#2472c8' });
    expect(spans[1]).toEqual({ text: 'B' });
  });

  it('空参数序列 \\x1b[m 等价于重置', () => {
    const spans = parseAnsiSpans('\x1b[31mA\x1b[mB');
    expect(spans[1]).toEqual({ text: 'B' });
  });

  it('非 SGR 的 CSI 序列被剥掉且不产生段', () => {
    const spans = parseAnsiSpans('A\x1b[2KB');
    expect(spans.map((s) => s.text).join('')).toBe('AB');
  });

  it('chalk 实际输出可解析(嵌套 reset-fg 语义)', () => {
    // 模拟 chalk.bgHex('#1e4023').hex('#b6e3bc')('x [36minner[39m y') 的展开:
    // 内层 39 后应回到「无 fg」(由外层 <Text color> 兜底),bg 保持。
    const s = '\x1b[48;2;30;64;35m\x1b[38;2;182;227;188mx \x1b[36minner\x1b[39m y\x1b[49m\x1b[39m';
    const spans = parseAnsiSpans(s);
    expect(spans[0]).toMatchObject({ text: 'x ', fg: '#b6e3bc', bg: '#1e4023' });
    expect(spans[1]).toMatchObject({ text: 'inner', fg: '#11a8cd', bg: '#1e4023' });
    expect(spans[2]?.fg).toBeUndefined(); // 39 → 继承外层
    expect(spans[2]?.bg).toBe('#1e4023');
  });
});

describe('OSC 序列剥离(超链接等)', () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);

  it('OSC 8 超链接只留可见文字', () => {
    const s = `见 ${ESC}]8;;https://example.com${BEL}文档${ESC}]8;;${BEL} 说明`;
    expect(parseAnsiSpans(s).map((x) => x.text).join('')).toBe('见 文档 说明');
  });

  it('ESC \\ 结尾的 OSC 同样剥掉', () => {
    const s = `A${ESC}]0;窗口标题${ESC}\\B`;
    expect(parseAnsiSpans(s).map((x) => x.text).join('')).toBe('AB');
  });

  it('OSC 与 SGR 混排时颜色仍然正确', () => {
    const s = `${ESC}[31m红${ESC}]8;;u${BEL}链${ESC}]8;;${BEL}${ESC}[39m 尾`;
    const spans = parseAnsiSpans(s);
    expect(spans.map((x) => x.text).join('')).toBe('红链 尾');
    expect(spans[0]).toMatchObject({ text: '红', fg: '#cd3131' });
    expect(spans[1]).toMatchObject({ text: '链', fg: '#cd3131' });
    expect(spans.at(-1)?.fg).toBeUndefined();
  });

  it('hasAnsi 认得 OSC(不只是 CSI)', () => {
    expect(hasAnsi(`x${ESC}]8;;u${BEL}y`)).toBe(true);
  });
});

describe('非 SGR 的 CSI 与冒号形 SGR', () => {
  const ESC = String.fromCharCode(27);

  it('私有模式序列(藏/显光标)被整段剥掉', () => {
    const s = `${ESC}[?25lhello${ESC}[?25h`;
    expect(parseAnsiSpans(s).map((x) => x.text).join('')).toBe('hello');
  });

  it('冒号形 SGR(ITU T.416)按子参数解析出颜色', () => {
    const spans = parseAnsiSpans(`${ESC}[38:5:196mX${ESC}[39m`);
    expect(spans[0]).toMatchObject({ text: 'X', fg: '#ff0000' });
  });

  it('带中间字节的 CSI 与光标移动序列剥净不留伪影', () => {
    const s = `A${ESC}[1;2 qB${ESC}[10;20HC${ESC}[2K${ESC}[1GD`;
    const joined = parseAnsiSpans(s).map((x) => x.text).join('');
    expect(joined).toBe('ABCD');
    expect(joined).not.toContain('[');
  });
});
