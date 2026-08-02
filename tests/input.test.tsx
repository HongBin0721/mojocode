import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Input, type SlashCommand } from '../src/ui/Input.js';

// Ink 会把单独的 ESC 缓冲 20ms 再分发(等着看是不是转义序列的开头),
// 等待时间必须盖过它。
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

const ENTER = '\r';
const SPACE = ' ';
const DOWN = '[B';

function setup(commands: SlashCommand[], onEscape?: () => void) {
  const submitted: string[] = [];
  const view = render(
    <Input
      onSubmit={(value) => submitted.push(value)}
      disabled={false}
      placeholder=""
      commands={commands}
      onEscape={onEscape}
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
