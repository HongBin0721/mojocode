import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Markdown } from '../src/ui/Markdown.js';
import { plain } from './support/ansi.js';

describe('Markdown(流式预览渲染)', () => {
  it('渲染各类块级与行内语法,且不输出原始标记', () => {
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

    const { lastFrame, unmount } = render(<Markdown text={text} />);
    const out = plain(lastFrame());
    unmount();

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
  });

  it('流式截断的未闭合代码块不会崩溃', () => {
    const { lastFrame, unmount } = render(<Markdown text={'```py\nprint(1)'} />);
    expect(plain(lastFrame())).toContain('print(1)');
    unmount();
  });

  it('不相干的星号不会被当成斜体而吃掉字符', () => {
    const { lastFrame, unmount } = render(<Markdown text="run tests on *.ts and *.js files" />);
    expect(plain(lastFrame())).toContain('*.ts and *.js files');
    unmount();
  });

  it('乘号两侧的星号不会被当成斜体', () => {
    const { lastFrame, unmount } = render(<Markdown text="grid is 2*3 and 4*5 cells" />);
    expect(plain(lastFrame())).toContain('2*3 and 4*5');
    unmount();
  });

  it('真正的斜体仍然生效', () => {
    const { lastFrame, unmount } = render(<Markdown text="a *really* good idea" />);
    const out = plain(lastFrame());
    expect(out).toContain('really');
    expect(out).not.toContain('*really*');
    unmount();
  });
});
