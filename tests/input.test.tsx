import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Input, type SlashCommand } from '../src/ui/Input.js';

// Ink 会把单独的 ESC 缓冲 20ms 再分发(等着看是不是转义序列的开头),
// 等待时间必须盖过它。
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

const ENTER = '\r';
const SPACE = ' ';
const DOWN = '[B';

function setup(
  commands: SlashCommand[],
  onEscape?: () => void,
  fileIndex?: () => Promise<string[]>,
) {
  const submitted: string[] = [];
  const view = render(
    <Input
      onSubmit={(value) => submitted.push(value)}
      disabled={false}
      placeholder=""
      commands={commands}
      onEscape={onEscape}
      fileIndex={fileIndex}
    />,
  );
  return { submitted, ...view };
}

const ESC = '';

describe('Input 斜杠命令菜单', () => {
  it('输入完整命令名回车执行精确匹配项,而不是菜单首个前缀匹配', async () => {
    // model 排在 mode 前:回归测试——曾经输入 /mode 回车会执行 /model。
    const { submitted, stdin, unmount } = setup([
      { name: 'model', description: '', options: () => [{ value: 'x' }] },
      { name: 'mode', description: '' },
    ]);

    stdin.write('/mode');
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(submitted).toEqual(['/mode']);
    unmount();
  });

  it('前缀输入回车仍执行菜单里选中的第一项', async () => {
    const { submitted, stdin, unmount } = setup([
      { name: 'clear', description: '' },
      { name: 'compact', description: '' },
    ]);

    stdin.write('/cl');
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(submitted).toEqual(['/clear']);
    unmount();
  });
});

describe('Input esc 分发', () => {
  it('菜单未打开时 esc 触发 onEscape(用于中断运行中的任务)', async () => {
    let escaped = 0;
    const { stdin, unmount } = setup([{ name: 'clear', description: '' }], () => escaped++);

    await tick(); // 等 stdin 监听就绪
    stdin.write(ESC);
    await tick();

    expect(escaped).toBe(1);
    unmount();
  });

  it('命令菜单打开时 esc 只收起菜单,不触发 onEscape', async () => {
    let escaped = 0;
    const { stdin, unmount } = setup([{ name: 'clear', description: '' }], () => escaped++);

    stdin.write('/cl');
    await tick();
    stdin.write(ESC); // 收起菜单
    await tick();

    expect(escaped).toBe(0);
    unmount();
  });
});

describe('Input 多选选择器', () => {
  const statusbar: SlashCommand = {
    name: 'statusbar',
    description: '',
    multi: true,
    options: () => [
      { value: 'model', current: true },
      { value: 'context' },
      { value: 'total' },
    ],
  };

  it('空格勾选、回车按选项顺序提交所有选中值', async () => {
    const { submitted, stdin, unmount } = setup([statusbar]);

    stdin.write('/statusbar');
    await tick();
    stdin.write(ENTER); // 进入选择器
    await tick();
    stdin.write(DOWN); // 光标移到 context
    await tick();
    stdin.write(SPACE); // 勾选 context
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(submitted).toEqual(['/statusbar model context']);
    unmount();
  });

  it('全部取消勾选后回车提交 none', async () => {
    const { submitted, stdin, unmount } = setup([statusbar]);

    stdin.write('/statusbar');
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write(SPACE); // 取消预选的 model
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(submitted).toEqual(['/statusbar none']);
    unmount();
  });

  it('esc 关闭选择器且不提交', async () => {
    const { submitted, stdin, unmount } = setup([statusbar]);

    stdin.write('/statusbar');
    await tick();
    stdin.write(ENTER);
    await tick();
    stdin.write(''); // esc
    await tick();

    expect(submitted).toEqual([]);
    unmount();
  });
});

describe('@ 文件引用补全', () => {
  const FILES = ['src/ui/Input.tsx', 'src/agent/loop.ts', 'README.md'];
  const fileIndex = () => Promise.resolve(FILES);

  it('输入 @ 弹出文件菜单,回车在 token 区间插入选中路径', async () => {
    const { submitted, stdin, lastFrame, unmount } = setup([], undefined, fileIndex);

    stdin.write('看看 @');
    await tick();
    expect(lastFrame()).toContain('src/ui/Input.tsx');

    stdin.write(ENTER); // 插入第一项而不是提交
    await tick();
    expect(submitted).toEqual([]);
    expect(lastFrame()).toContain('@src/ui/Input.tsx');

    stdin.write(ENTER); // 菜单已关(token 后有空格),这次才是提交
    await tick();
    expect(submitted).toEqual(['看看 @src/ui/Input.tsx']);
    unmount();
  });

  it('输入片段模糊过滤,↓ 移动后 tab 插入', async () => {
    const { stdin, lastFrame, unmount } = setup([], undefined, fileIndex);

    stdin.write('@src');
    await tick();
    expect(lastFrame()).toContain('src/ui/Input.tsx');
    expect(lastFrame()).not.toContain('README.md');

    stdin.write('\x1b[B'); // ↓
    await tick();
    stdin.write('\t');
    await tick();
    const frame = lastFrame()!;
    expect(frame.includes('@src/ui/Input.tsx') || frame.includes('@src/agent/loop.ts')).toBe(true);
    unmount();
  });

  it('esc 只收起文件菜单,不触发 onEscape;再输入时菜单重新出现', async () => {
    let escaped = 0;
    const { submitted, stdin, lastFrame, unmount } = setup([], () => escaped++, fileIndex);

    stdin.write('@RE');
    await tick();
    expect(lastFrame()).toContain('README.md');

    stdin.write(ESC);
    await tick();
    expect(escaped).toBe(0);

    stdin.write(ENTER); // 菜单已收起 → 直接提交原文
    await tick();
    expect(submitted).toEqual(['@RE']);
    unmount();
  });

  // 模糊匹配是子序列匹配,几乎对任何词都能命中点什么;回车若一律插入,
  // 正常行文里的 @词 一按回车就被改写成不相干的路径,而不是发送消息。
  // `ipt` 是 Input.tsx 的子序列但不是它的前缀。
  it('候选只是模糊命中(非前缀)时,回车照常提交而不是插入路径', async () => {
    const { submitted, stdin, lastFrame, unmount } = setup([], undefined, fileIndex);

    stdin.write('看下 @ipt');
    await tick();
    expect(lastFrame()).toContain('src/ui/Input.tsx'); // 菜单确实开着

    stdin.write(ENTER);
    await tick();
    expect(submitted).toEqual(['看下 @ipt']);
    unmount();
  });

  it('候选以输入串开头时,回车仍然插入(前缀即选择意图)', async () => {
    const { submitted, stdin, lastFrame, unmount } = setup([], undefined, fileIndex);

    stdin.write('@src/ui');
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(submitted).toEqual([]);
    expect(lastFrame()).toContain('@src/ui/Input.tsx');
    unmount();
  });

  it('上下键选过之后,回车插入选中项', async () => {
    const { submitted, stdin, lastFrame, unmount } = setup([], undefined, fileIndex);

    stdin.write('看下 @ipt');
    await tick();
    stdin.write('\x1b[B'); // ↓ 明确表达选择意图
    await tick();
    stdin.write(ENTER);
    await tick();

    expect(submitted).toEqual([]);
    expect(lastFrame()).toContain('看下 @');
    expect(lastFrame()).not.toContain('@ipt');
    unmount();
  });

  it('@ 前不是空白(邮箱等)不弹菜单', async () => {
    const { stdin, lastFrame, unmount } = setup([], undefined, fileIndex);

    stdin.write('foo@RE');
    await tick();
    expect(lastFrame()).not.toContain('README.md');
    unmount();
  });

  it('未注入 fileIndex 时 @ 不产生任何菜单', async () => {
    const { stdin, lastFrame, unmount } = setup([]);

    stdin.write('@RE');
    await tick();
    expect(lastFrame()).not.toContain('README.md');
    unmount();
  });
});

describe('ctrl+v 粘贴图片', () => {
  const CTRL_V = '\x16';
  const IMG = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };

  function setupPaste(read: () => Promise<typeof IMG | undefined>) {
    const submitted: [string, unknown][] = [];
    const notices: string[] = [];
    const view = render(
      <Input
        onSubmit={(value, images) => submitted.push([value, images])}
        disabled={false}
        placeholder=""
        commands={[]}
        readClipboardImage={read}
        onImageNotice={(message) => notices.push(message)}
      />,
    );
    return { submitted, notices, ...view };
  }

  it('粘贴插入占位符,提交时把图片一并传出', async () => {
    const { submitted, stdin, lastFrame, unmount } = setupPaste(() => Promise.resolve(IMG));

    stdin.write('看这个 ');
    await tick();
    stdin.write(CTRL_V);
    await tick();
    expect(lastFrame()).toContain('[image #1]');

    stdin.write('\r');
    await tick();
    expect(submitted).toEqual([
      [
        '看这个 [image #1]',
        [{ mediaType: 'image/png', data: IMG.data, filename: 'clipboard-1.png' }],
      ],
    ]);
    unmount();
  });

  it('占位符被删掉后提交不带图片', async () => {
    const { submitted, stdin, unmount } = setupPaste(() => Promise.resolve(IMG));

    stdin.write(CTRL_V);
    await tick();
    stdin.write('\x15'); // ctrl+u 清空整行(占位符没了)
    await tick();
    stdin.write('只有文字');
    await tick();
    stdin.write('\r');
    await tick();

    expect(submitted).toEqual([['只有文字', undefined]]);
    unmount();
  });

  it('退格一次删除整个占位符,而不是逐字符删', async () => {
    const { submitted, stdin, lastFrame, unmount } = setupPaste(() => Promise.resolve(IMG));

    stdin.write('看 ');
    await tick();
    stdin.write(CTRL_V);
    await tick();
    expect(lastFrame()).toContain('[image #1]');

    stdin.write('\x7f'); // backspace
    await tick();
    expect(lastFrame()).not.toContain('[image #1]');

    stdin.write('完');
    await tick();
    stdin.write('\r');
    await tick();
    expect(submitted).toEqual([['看 完', undefined]]);
    unmount();
  });

  it('光标移进占位符中间退格,同样整个删除', async () => {
    const { stdin, lastFrame, unmount } = setupPaste(() => Promise.resolve(IMG));

    stdin.write(CTRL_V);
    await tick();
    stdin.write('\x1b[D'); // ← 移进占位符内部
    await tick();
    stdin.write('\x1b[D');
    await tick();
    stdin.write('\x7f');
    await tick();

    expect(lastFrame()).not.toContain('[image #');
    unmount();
  });

  it('普通文本的退格不受影响', async () => {
    const { submitted, stdin, unmount } = setupPaste(() => Promise.resolve(IMG));

    stdin.write('abc');
    await tick();
    stdin.write('\x7f');
    await tick();
    stdin.write('\r');
    await tick();

    expect(submitted).toEqual([['ab', undefined]]);
    unmount();
  });

  it('剪贴板没有图片时提示且不插占位符', async () => {
    const { notices, stdin, lastFrame, unmount } = setupPaste(() => Promise.resolve(undefined));

    stdin.write(CTRL_V);
    await tick();

    expect(notices).toHaveLength(1);
    expect(lastFrame()).not.toContain('[image #');
    unmount();
  });

  it('未注入 readClipboardImage 时 ctrl+v 保持无动作', async () => {
    const { submitted, stdin, lastFrame, unmount } = setup([]);

    stdin.write('abc');
    await tick();
    stdin.write('\x16');
    await tick();
    expect(lastFrame()).not.toContain('[image #');
    stdin.write('\r');
    await tick();
    expect(submitted).toEqual(['abc']);
    unmount();
  });
});

describe('tab 与 shift+tab 的分工', () => {
  const commands: SlashCommand[] = [
    { name: 'plan', description: '计划模式' },
    { name: 'provider', description: '切换服务商' },
  ];

  it('tab 仍然补全命令', async () => {
    const { stdin, lastFrame, unmount } = setup(commands);
    await tick();
    stdin.write('/pl');
    await tick();
    stdin.write('\t');
    await tick();
    expect(lastFrame()).toContain('/plan');
    unmount();
  });

  // shift+tab 是全局切权限模式的快捷键,ink 把它报成 tab + shift。
  // 不排除 shift 的话,命令菜单一开它就被补全吞掉,模式永远切不动。
  it('shift+tab 不触发补全,留给全局快捷键', async () => {
    const { stdin, lastFrame, unmount } = setup(commands);
    await tick();
    stdin.write('/pl');
    await tick();
    const before = lastFrame();
    stdin.write('\x1b[Z');
    await tick();
    expect(lastFrame()).toBe(before);
    unmount();
  });
});
