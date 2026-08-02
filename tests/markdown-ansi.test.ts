import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { renderMarkdownAnsi } from '../src/ui/markdown-ansi.js';

/** 去掉 ANSI 转义,便于断言纯文本内容。 */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '');
}

describe('renderMarkdownAnsi', () => {
  it('表格渲染为对齐的框线表格', () => {
    const out = plain(
      renderMarkdownAnsi('| 订单号 | 状态 |\n|---|---|\n| #A1023 | 已发货 |', 80),
    );
    expect(out).toContain('┌');
    expect(out).toContain('│');
    expect(out).toContain('#A1023');
    expect(out).not.toContain('|---|');
  });

  it('代码块保留内容且围栏被剥掉', () => {
    const out = plain(renderMarkdownAnsi('```js\nconst x = 1;\n```', 80));
    expect(out).toContain('const x = 1;');
    expect(out).not.toContain('```');
  });

  it('行内标记被消费,通配符星号不受影响', () => {
    const out = plain(renderMarkdownAnsi('**bold** and `code` with *.ts and *.js globs', 80));
    expect(out).toContain('bold and code');
    expect(out).toContain('*.ts and *.js globs');
    expect(out).not.toContain('**');
  });

  it('标题不带 # 前缀', () => {
    const out = plain(renderMarkdownAnsi('# Title\n\nbody', 80));
    expect(out).toContain('Title');
    expect(out).not.toContain('# Title');
  });

  it('宽度变化时重建实例仍正常', () => {
    expect(plain(renderMarkdownAnsi('hello', 80))).toContain('hello');
    expect(plain(renderMarkdownAnsi('hello', 40))).toContain('hello');
  });

  it('CJK 段落按显示宽度折行,任何行不超过给定列数', () => {
    // marked-terminal 自带的 reflow 按字符数计宽,这段 40 个汉字若按字符数
    // 折行会输出 80 列宽的行;宽度感知折行后每行都必须 ≤ 40 列。
    const out = plain(renderMarkdownAnsi('设计纲领明确写着可读性优先于一切源码即成品'.repeat(2), 40));
    for (const line of out.split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(40);
    }
    // 内容一个字都不能丢。
    expect(out.replace(/\s/g, '')).toContain('设计纲领明确写着可读性优先于一切源码即成品');
  });

  it('列表项的折行续行保留悬挂缩进', () => {
    const out = plain(renderMarkdownAnsi(`- ${'很长的列表项内容'.repeat(8)}`, 40));
    const lines = out.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(40);
    }
    // 首行带项目符号,续行与其内容列对齐(前导空格)。
    for (const cont of lines.slice(1)) {
      expect(cont.startsWith('  ')).toBe(true);
    }
  });

  it('混排英文与 CJK 的长段落同样不超宽', () => {
    const text =
      'Markdown、Org-mode、AsciiDoc 三者的取舍:**生态碾压设计**——解析器几百行就能写,于是无处不在,表达力最差却成了事实标准。';
    const out = plain(renderMarkdownAnsi(text.repeat(3), 50));
    for (const line of out.split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(50);
    }
  });
});
