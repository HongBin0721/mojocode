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

  // marked-terminal 画表格不受 width 约束,CJK 表格超宽后会被 wrapLine 切碎;
  // patchTableRendering 按列预算预折单元格,保证整张表不超终端宽度。
  it('CJK 长单元格的表格不超宽,框线完整', () => {
    const md = [
      '| 分类 | 内容 |',
      '|---|---|',
      `| 研究 | ${'R1、V3、Coder V2、VL 等开源模型'.repeat(3)} |`,
      '| 产品 | DeepSeek App、网页版、开放平台、API 价格、服务状态 |',
    ].join('\n');
    const out = plain(renderMarkdownAnsi(md, 60));
    const lines = out.split('\n').filter(Boolean);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(60);
    }
    // 每一行都是完整的框线行或单元格行,不存在被拦腰切断顶回行首的碎片。
    for (const line of lines) {
      expect(line.startsWith('┌') || line.startsWith('│') || line.startsWith('├') || line.startsWith('└')).toBe(true);
    }
    // 内容一个字不丢。
    expect(out.replace(/\s/g, '')).toContain('服务状态');
  });

  it('表格单元格里的自动链接不展开 (mailto:…)', () => {
    const out = plain(
      renderMarkdownAnsi('| 联系 |\n|---|\n| security@deepseek.com |', 80),
    );
    expect(out).toContain('security@deepseek.com');
    expect(out).not.toContain('mailto:');
  });

  it('表格单元格保留实体反转义与 codespan 冒号', () => {
    const out = plain(renderMarkdownAnsi('| 键 | 值 |\n|---|---|\n| R&D | `a:b` |', 80));
    expect(out).toContain('R&D');
    expect(out).toContain('a:b');
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

  // marked-terminal 7.3.0 在 marked 15 下的两处列表缺陷,由 patchListRendering 接管。
  it('列表项内的行内标记同样被消费(不是只有段落生效)', () => {
    const out = plain(
      renderMarkdownAnsi('1. **粗体** 与 `代码`\n2. 另一项 **也要** 生效', 80),
    );
    expect(out).toContain('粗体 与 代码');
    expect(out).not.toContain('**');
    expect(out).not.toContain('`');
  });

  it('有序列表里的无序子项不会被接着编号', () => {
    const src = ['1. 父项一', '    * 子项 A', '    * 子项 B', '2. 父项二'].join('\n');
    const lines = plain(renderMarkdownAnsi(src, 80))
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines).toEqual(['1. 父项一', '- 子项 A', '- 子项 B', '2. 父项二']);
  });

  it('有序列表按 start 起编,子项缩进在父项正文之下', () => {
    const src = ['3. 第三项', '    - 子项', '4. 第四项'].join('\n');
    const out = plain(renderMarkdownAnsi(src, 80));
    expect(out).toContain('3. 第三项');
    expect(out).toContain('4. 第四项');
    // 父项标记 "3. " 宽 3 列,子项悬挂在其后。
    expect(out).toContain('   - 子项');
  });

  it('从 0 起编的有序列表保留 0', () => {
    const out = plain(renderMarkdownAnsi('0. 零\n1. 一', 80));
    expect(out).toContain('0. 零');
    expect(out).toContain('1. 一');
  });

  it('有序列表项的折行续行挂在正文下方,不顶回行首', () => {
    const out = plain(renderMarkdownAnsi(`1. ${'很长的列表项内容'.repeat(8)}`, 40));
    const lines = out.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(1);
    for (const cont of lines.slice(1)) {
      // "1. " 占 3 列。
      expect(cont.startsWith('   ')).toBe(true);
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

describe('链接渲染(不发 OSC 8)', () => {
  const ESC = String.fromCharCode(27);

  it('支持超链接的终端下也渲染成 文字 (url)', () => {
    const prev = process.env.FORCE_HYPERLINK;
    process.env.FORCE_HYPERLINK = '1';
    try {
      const out = renderMarkdownAnsi('见 [文档](https://example.com) 说明', 60);
      expect(out).toContain('文档 (https://example.com)');
      expect(out).not.toContain(`${ESC}]8;;`);
    } finally {
      if (prev === undefined) delete process.env.FORCE_HYPERLINK;
      else process.env.FORCE_HYPERLINK = prev;
    }
  });

  it('裸 URL 链接不重复展示', () => {
    const out = renderMarkdownAnsi('见 <https://example.com> 说明', 60);
    expect(out).toContain('https://example.com');
    expect(out).not.toContain('https://example.com (https://example.com)');
  });
});
