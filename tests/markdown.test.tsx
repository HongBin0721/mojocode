import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { render } from 'ink';
import { Markdown } from '../src/ui/Markdown.js';

/** 把组件渲染进内存流,取纯文本输出断言。 */
function renderToString(element: React.ReactElement): string {
  let out = '';
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      out += String(chunk);
      cb();
    },
  });
  Object.assign(stdout, { columns: 80, rows: 24, isTTY: false });
  const app = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  });
  app.unmount();
  return out;
}

describe('Markdown', () => {
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

    const out = renderToString(<Markdown text={text} />);

    expect(out).toContain('Title');
    expect(out).toContain('code');
    expect(out).toContain('bold');
    expect(out).toContain('• item one');
    expect(out).toContain('2) ordered'.replace(')', '.'));
    expect(out).toContain('│ quoted');
    expect(out).toContain('const x = 1;');
    expect(out).toContain('after blank');
    // 围栏与行内标记本身不应出现在输出里。
    expect(out).not.toContain('```');
    expect(out).not.toContain('**');
    expect(out).not.toContain('# ');
  });

  it('流式截断的未闭合代码块不会崩溃', () => {
    const out = renderToString(<Markdown text={'```py\nprint(1)'} />);
    expect(out).toContain('print(1)');
  });

  it('不相干的星号不会被当成斜体而吃掉字符', () => {
    const out = renderToString(<Markdown text="run tests on *.ts and *.js files" />);
    expect(out).toContain('*.ts and *.js files');
  });

  it('乘号两侧的星号不会被当成斜体', () => {
    const out = renderToString(<Markdown text="grid is 2*3 and 4*5 cells" />);
    expect(out).toContain('2*3 and 4*5');
  });

  it('真正的斜体仍然生效', () => {
    const out = renderToString(<Markdown text="a *really* good idea" />);
    expect(out).toContain('really');
    expect(out).not.toContain('*really*');
  });
});
