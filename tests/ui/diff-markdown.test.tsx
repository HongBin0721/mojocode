import { describe, expect, it } from 'vitest';
import React from 'react';
import { Diff } from '../../src/ui/Diff.js';
import { Markdown } from '../../src/ui/Markdown.js';
import { renderUi } from '../support/otui.js';

const PATCH = [
  '--- a/foo.ts',
  '+++ b/foo.ts',
  '@@ -1,3 +1,3 @@',
  ' const keep = 1;',
  '-const removed = 2;',
  '+const added = 3;',
  '',
].join('\n');

/** 在 spans 帧里找包含某文本的行。 */
function findLine(spans: { lines: { spans: { text: string; bg: { buffer: Record<number, number> } }[] }[] }, needle: string) {
  return spans.lines.find((l) => l.spans.map((s) => s.text).join('').includes(needle));
}

describe('Diff 在 OpenTUI 下渲染', () => {
  it('行号、+/- 行与折叠提示', async () => {
    const ui = await renderUi(<Diff patch={PATCH} maxLines={2} />, { width: 60, height: 8 });
    const frame = ui.frame();
    expect(frame).toContain('const keep = 1;');
    expect(frame).toContain('- const removed = 2;');
    expect(frame).not.toContain('const added'); // maxLines=2 折叠
    await ui.destroy();
  });

  it('新增行整行带背景色,语法高亮段不打断背景(chalk 嵌套语义)', async () => {
    const ui = await renderUi(<Diff patch={PATCH} />, { width: 60, height: 8 });
    const line = findLine(ui.spans(), 'const added = 3;');
    expect(line).toBeDefined();
    // 从 "+" 到行文本结束的每个 span 背景都应是 diffAddedBg #1e4023 (30,64,35)
    const contentSpans = line!.spans.filter((s) => s.text.includes('+') || /const|added|3/.test(s.text));
    expect(contentSpans.length).toBeGreaterThan(0);
    for (const span of contentSpans) {
      expect([span.bg.buffer[0], span.bg.buffer[1], span.bg.buffer[2]]).toEqual([30, 64, 35]);
    }
    await ui.destroy();
  });
});

describe('Markdown(流式)在 OpenTUI 下渲染', () => {
  it('标题/列表/行内样式', async () => {
    const ui = await renderUi(
      <Markdown text={'# 标题\n\n- 第一项 **加粗** 与 `code`\n> 引用行'} />,
      { width: 40, height: 8 },
    );
    const frame = ui.frame();
    expect(frame).toContain('标题');
    expect(frame).toContain('- 第一项 加粗 与 code');
    expect(frame).toContain('│ 引用行');
    await ui.destroy();
  });

  it('*.ts and *.js 不被误判为斜体(字符不丢)', async () => {
    const ui = await renderUi(<Markdown text={'匹配 *.ts and *.js 文件'} />, {
      width: 40,
      height: 4,
    });
    expect(ui.frame()).toContain('匹配 *.ts and *.js 文件');
    await ui.destroy();
  });

  it('代码围栏内容缩进渲染,围栏行本身不渲染', async () => {
    const ui = await renderUi(<Markdown text={'```ts\nconst x = 1;\n```'} />, {
      width: 40,
      height: 4,
    });
    const frame = ui.frame();
    expect(frame).toContain('  const x = 1;');
    expect(frame).not.toContain('```');
    await ui.destroy();
  });
});

describe('Markdown 语法覆盖', () => {
  it('渲染各类块级与行内语法,且不输出原始标记', async () => {
    const text = [
      '# Title',
      'Plain with `code` and **bold** and *italic*.',
      '- item one',
      '2. ordered',
      '> quoted',
      '---',
      '```js',
      'const x = 1;',
      '```',
      '',
      'after blank',
    ].join('\n');

    const ui = await renderUi(<Markdown text={text} />, { width: 60, height: 16 });
    const out = ui.frame();

    expect(out).toContain('Title');
    expect(out).toContain('code');
    expect(out).toContain('bold');
    expect(out).toContain('- item one');
    expect(out).toContain('2. ordered');
    expect(out).toContain('│ quoted');
    expect(out).toContain('const x = 1;');
    expect(out).toContain('after blank');
    // 围栏与行内标记本身不应出现在输出里。
    expect(out).not.toContain('```');
    expect(out).not.toContain('**');
    expect(out).not.toContain('# ');
    await ui.destroy();
  });

  it('流式截断的未闭合代码块不会崩溃', async () => {
    const ui = await renderUi(<Markdown text={'```py\nprint(1)'} />, { width: 40, height: 4 });
    expect(ui.frame()).toContain('print(1)');
    await ui.destroy();
  });

  it('乘号两侧的星号不会被当成斜体', async () => {
    const ui = await renderUi(<Markdown text="grid is 2*3 and 4*5 cells" />, {
      width: 40,
      height: 4,
    });
    expect(ui.frame()).toContain('2*3 and 4*5');
    await ui.destroy();
  });

  it('真正的斜体仍然生效', async () => {
    const ui = await renderUi(<Markdown text="a *really* good idea" />, { width: 40, height: 4 });
    const out = ui.frame();
    expect(out).toContain('really');
    expect(out).not.toContain('*really*');
    await ui.destroy();
  });
});

describe('Diff 边界', () => {
  const patch = [
    '--- src/app.ts',
    '+++ src/app.ts',
    '@@ -10,3 +10,4 @@',
    ' const before = 1;',
    "-const dishes = ['a'];",
    "+const dishes = ['a', 'b'];",
    '',
  ].join('\n');

  it('渲染行号与 +/- 标记,且不丢失代码文本', async () => {
    const ui = await renderUi(<Diff patch={patch} />, { width: 70, height: 8 });
    const out = ui.frame();
    expect(out).toContain('10');
    expect(out).toContain("- const dishes = ['a'];");
    expect(out).toContain("+ const dishes = ['a', 'b'];");
    // 文件头不出现在渲染结果里。
    expect(out).not.toContain('+++');
    await ui.destroy();
  });

  // hunk 内部以 ---/+++ 开头的是普通内容,不是文件头:当成文件头跳过会让
  // 改动从 diff 里凭空消失,而同一个组件也渲染写入/编辑的授权确认框。
  it('新增顶格的 ++ 内容行不会被当成文件头丢掉', async () => {
    const p = [
      '--- src/main.cpp',
      '+++ src/main.cpp',
      '@@ -1,2 +1,3 @@',
      ' i = 0;',
      '+++i;',
      ' return i;',
    ].join('\n');
    const ui = await renderUi(<Diff patch={p} />, { width: 60, height: 8 });
    expect(ui.frame()).toContain('+ ++i;');
    await ui.destroy();
  });

  it('删除顶格的 -- 内容行不会被丢掉,且旧文件行号继续推进', async () => {
    const p = [
      '--- src/query.sql',
      '+++ src/query.sql',
      '@@ -1,3 +1,2 @@',
      ' select 1;',
      '--- legacy note',
      ' select 2;',
    ].join('\n');
    const ui = await renderUi(<Diff patch={p} />, { width: 60, height: 8 });
    const out = ui.frame();
    expect(out).toContain('- -- legacy note');
    // 删除行占掉旧文件的第 2 行,其后的上下文行仍是新文件的第 2 行。
    expect(out).toContain('2 - -- legacy note');
    await ui.destroy();
  });

  it('多个 hunk 之间插入折叠标记', async () => {
    const multi = [
      '--- a.ts',
      '+++ a.ts',
      '@@ -1,1 +1,1 @@',
      '-let a = 1;',
      '@@ -20,1 +20,1 @@',
      '-let b = 2;',
    ].join('\n');
    const ui = await renderUi(<Diff patch={multi} />, { width: 60, height: 8 });
    expect(ui.frame()).toContain('⋯');
    await ui.destroy();
  });
});
