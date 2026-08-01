import { describe, expect, it } from 'vitest';
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
});
