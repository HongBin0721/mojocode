import { describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { Input, type SlashCommand } from '../../src/ui/Input.js';
import { renderUi } from '../support/otui.js';

function setup(
  commands: SlashCommand[],
  onEscape?: () => void,
  fileIndex?: () => Promise<string[]>,
) {
  const submitted: string[] = [];
  const ui = renderUi(
    () => <Input
      onSubmit={(value) => submitted.push(value)}
      disabled={false}
      placeholder=""
      commands={commands}
      onEscape={onEscape}
      fileIndex={fileIndex}
    />,
    { width: 80, height: 16 },
  );
  return { submitted, ui };
}

describe('Input 基础编辑', () => {
  it('输入并回车提交;历史 ↑ 找回', async () => {
    const { submitted, ui: p } = setup([]);
    const ui = await p;
    await ui.type('你好 world');
    await ui.press('return');
    expect(submitted).toEqual(['你好 world']);
    await ui.press('up'); // 历史回翻
    expect(ui.frame()).toContain('你好 world');
    await ui.destroy();
  });

  it('ctrl+j 插入换行(多行编辑)', async () => {
    const { submitted, ui: p } = setup([]);
    const ui = await p;
    await ui.type('第一行');
    await ui.press('j', { ctrl: true });
    await ui.type('第二行');
    await ui.press('return');
    expect(submitted).toEqual(['第一行\n第二行']);
    await ui.destroy();
  });

  // 回归:OpenTUI 把一个 stdin chunk 拆成逐字符 keypress 同步连发。kit 的
  // useInput 把普通字符合并、特殊键到达时**先同步冲刷**再派发——顺序错了,
  // 回车会在文字落进输入框之前处理,表现为文字进了框却提交空串。(React
  // 时代这里还叠着 flushSync 的旧闭包问题;Solid 读信号即当前值,但冲刷
  // 先于特殊键派发的顺序契约不变,本测试锁的就是它。)
  // 触发场景:快速输入、按键重复、无 bracketed paste 的终端里粘贴含换行文本。
  it('文字与回车同批到达时不丢内容(同步连发回归)', async () => {
    const { submitted, ui: p } = setup([]);
    const ui = await p;
    void ui.mockInput.pressKeys(['h', 'i', 'RETURN'], 0);
    await sleep(50);
    await ui.tick();
    expect(submitted).toEqual(['hi']);
    await ui.destroy();
  });

  it('bracketed paste 多行文本一次插入,不触发提交', async () => {
    const { submitted, ui: p } = setup([]);
    const ui = await p;
    await ui.paste('line1\nline2');
    expect(submitted).toEqual([]);
    await ui.press('return');
    expect(submitted).toEqual(['line1\nline2']);
    await ui.destroy();
  });
});

describe('Input 斜杠命令菜单', () => {
  it('输入完整命令名回车执行精确匹配项,而不是菜单首个前缀匹配', async () => {
    // model 排在 mode 前:回归测试——曾经输入 /mode 回车会执行 /model。
    const { submitted, ui: p } = setup([
      { name: 'model', description: '', options: () => [{ value: 'x' }] },
      { name: 'mode', description: '' },
    ]);
    const ui = await p;
    await ui.type('/mode');
    await ui.press('return');
    expect(submitted).toEqual(['/mode']);
    await ui.destroy();
  });

  it('前缀输入回车仍执行菜单里选中的第一项', async () => {
    const { submitted, ui: p } = setup([
      { name: 'clear', description: '' },
      { name: 'compact', description: '' },
    ]);
    const ui = await p;
    await ui.type('/cl');
    await ui.press('return');
    expect(submitted).toEqual(['/clear']);
    await ui.destroy();
  });
});

describe('Input esc 分发', () => {
  it('菜单未打开时 esc 触发 onEscape(用于中断运行中的任务)', async () => {
    let escaped = 0;
    const { ui: p } = setup([{ name: 'clear', description: '' }], () => escaped++);
    const ui = await p;
    await ui.press('escape');
    expect(escaped).toBe(1);
    await ui.destroy();
  });

  it('命令菜单打开时 esc 只收起菜单,不触发 onEscape', async () => {
    let escaped = 0;
    const { ui: p } = setup([{ name: 'clear', description: '' }], () => escaped++);
    const ui = await p;
    await ui.type('/cl');
    await ui.press('escape');
    expect(escaped).toBe(0);
    await ui.destroy();
  });
});

describe('Input 多选选择器', () => {
  // 内置命令目前没有用 multi 的(状态栏已并入 /setting 面板),这里用一个
  // 假命令测 Input 自带的多选能力本身。
  const picker: SlashCommand = {
    name: 'picker',
    description: '',
    multi: true,
    options: () => [
      { value: 'model', current: true },
      { value: 'context' },
      { value: 'total' },
    ],
  };

  it('空格勾选、回车按选项顺序提交所有选中值', async () => {
    const { submitted, ui: p } = setup([picker]);
    const ui = await p;
    await ui.type('/picker');
    await ui.press('return'); // 进入选择器
    await ui.tick();
    await ui.press('down'); // 光标移到 context
    await ui.type(' '); // 勾选
    await ui.press('return');
    expect(submitted).toEqual(['/picker model context']);
    await ui.destroy();
  });

  it('全部取消勾选后回车提交 none', async () => {
    const { submitted, ui: p } = setup([picker]);
    const ui = await p;
    await ui.type('/picker');
    await ui.press('return');
    await ui.tick();
    await ui.type(' '); // 取消预选的 model
    await ui.press('return');
    expect(submitted).toEqual(['/picker none']);
    await ui.destroy();
  });

  it('esc 关闭选择器且不提交', async () => {
    const { submitted, ui: p } = setup([picker]);
    const ui = await p;
    await ui.type('/picker');
    await ui.press('return');
    await ui.tick();
    await ui.press('escape');
    expect(submitted).toEqual([]);
    await ui.destroy();
  });
});

describe('@ 文件引用补全', () => {
  const FILES = ['src/ui/Input.tsx', 'src/agent/loop.ts', 'README.md'];
  const fileIndex = () => Promise.resolve(FILES);

  it('输入 @ 弹出文件菜单,回车在 token 区间插入选中路径', async () => {
    const { submitted, ui: p } = setup([], undefined, fileIndex);
    const ui = await p;
    await ui.type('看看 @');
    await ui.tick(); // 等异步文件列表
    expect(ui.frame()).toContain('src/ui/Input.tsx');

    await ui.press('return'); // 插入第一项而不是提交
    expect(submitted).toEqual([]);
    expect(ui.frame()).toContain('@src/ui/Input.tsx');

    await ui.press('return'); // 菜单已关(token 后有空格),这次才是提交
    expect(submitted).toEqual(['看看 @src/ui/Input.tsx']);
    await ui.destroy();
  });

  it('输入片段模糊过滤,↓ 移动后 tab 插入', async () => {
    const { ui: p } = setup([], undefined, fileIndex);
    const ui = await p;
    await ui.type('@src');
    await ui.tick();
    expect(ui.frame()).toContain('src/ui/Input.tsx');
    expect(ui.frame()).not.toContain('README.md');

    await ui.press('down');
    await ui.press('tab');
    const frame = ui.frame();
    expect(frame.includes('@src/ui/Input.tsx') || frame.includes('@src/agent/loop.ts')).toBe(true);
    await ui.destroy();
  });

  it('esc 只收起文件菜单,不触发 onEscape;回车提交原文', async () => {
    let escaped = 0;
    const { submitted, ui: p } = setup([], () => escaped++, fileIndex);
    const ui = await p;
    await ui.type('@RE');
    await ui.tick();
    expect(ui.frame()).toContain('README.md');

    await ui.press('escape');
    expect(escaped).toBe(0);

    await ui.press('return'); // 菜单已收起 → 直接提交原文
    expect(submitted).toEqual(['@RE']);
    await ui.destroy();
  });

  // 模糊匹配是子序列匹配,几乎对任何词都能命中点什么;回车若一律插入,
  // 正常行文里的 @词 一按回车就被改写成不相干的路径,而不是发送消息。
  it('候选只是模糊命中(非前缀)时,回车照常提交而不是插入路径', async () => {
    const { submitted, ui: p } = setup([], undefined, fileIndex);
    const ui = await p;
    await ui.type('看下 @ipt');
    await ui.tick();
    expect(ui.frame()).toContain('src/ui/Input.tsx'); // 菜单确实开着

    await ui.press('return');
    expect(submitted).toEqual(['看下 @ipt']);
    await ui.destroy();
  });

  it('候选以输入串开头时,回车仍然插入(前缀即选择意图)', async () => {
    const { submitted, ui: p } = setup([], undefined, fileIndex);
    const ui = await p;
    await ui.type('@src/ui');
    await ui.tick();
    await ui.press('return');
    expect(submitted).toEqual([]);
    expect(ui.frame()).toContain('@src/ui/Input.tsx');
    await ui.destroy();
  });

  it('上下键选过之后,回车插入选中项', async () => {
    const { submitted, ui: p } = setup([], undefined, fileIndex);
    const ui = await p;
    await ui.type('看下 @ipt');
    await ui.tick();
    await ui.press('down'); // 明确表达选择意图
    await ui.press('return');
    expect(submitted).toEqual([]);
    expect(ui.frame()).toContain('看下 @');
    expect(ui.frame()).not.toContain('@ipt');
    await ui.destroy();
  });

  it('@ 前不是空白(邮箱等)不弹菜单', async () => {
    const { ui: p } = setup([], undefined, fileIndex);
    const ui = await p;
    await ui.type('foo@RE');
    await ui.tick();
    expect(ui.frame()).not.toContain('README.md');
    await ui.destroy();
  });

  it('未注入 fileIndex 时 @ 不产生任何菜单', async () => {
    const { ui: p } = setup([]);
    const ui = await p;
    await ui.type('@RE');
    await ui.tick();
    expect(ui.frame()).not.toContain('README.md');
    await ui.destroy();
  });
});

describe('ctrl+v 粘贴图片', () => {
  const IMG = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };

  async function setupPaste(read: () => Promise<typeof IMG | undefined>) {
    const submitted: [string, unknown][] = [];
    const notices: string[] = [];
    const ui = await renderUi(
      () => <Input
        onSubmit={(value, images) => submitted.push([value, images])}
        disabled={false}
        placeholder=""
        commands={[]}
        readClipboardImage={read}
        onImageNotice={(message) => notices.push(message)}
      />,
      { width: 80, height: 10 },
    );
    return { submitted, notices, ui };
  }

  it('粘贴插入占位符,提交时把图片一并传出', async () => {
    const { submitted, ui } = await setupPaste(() => Promise.resolve(IMG));
    await ui.type('看这个 ');
    await ui.press('v', { ctrl: true });
    await ui.tick(); // 等异步剪贴板读取
    expect(ui.frame()).toContain('[image #1]');

    await ui.press('return');
    expect(submitted).toEqual([
      [
        '看这个 [image #1]',
        [{ mediaType: 'image/png', data: IMG.data, filename: 'clipboard-1.png' }],
      ],
    ]);
    await ui.destroy();
  });

  it('占位符被删掉后提交不带图片', async () => {
    const { submitted, ui } = await setupPaste(() => Promise.resolve(IMG));
    await ui.press('v', { ctrl: true });
    await ui.tick();
    await ui.press('u', { ctrl: true }); // 清空整行
    await ui.type('只有文字');
    await ui.press('return');
    expect(submitted).toEqual([['只有文字', undefined]]);
    await ui.destroy();
  });

  it('退格一次删除整个占位符,而不是逐字符删', async () => {
    const { submitted, ui } = await setupPaste(() => Promise.resolve(IMG));
    await ui.type('看 ');
    await ui.press('v', { ctrl: true });
    await ui.tick();
    expect(ui.frame()).toContain('[image #1]');

    await ui.press('backspace');
    expect(ui.frame()).not.toContain('[image #1]');

    await ui.type('完');
    await ui.press('return');
    expect(submitted).toEqual([['看 完', undefined]]);
    await ui.destroy();
  });

  it('光标移进占位符中间退格,同样整个删除', async () => {
    const { ui } = await setupPaste(() => Promise.resolve(IMG));
    await ui.press('v', { ctrl: true });
    await ui.tick();
    await ui.press('left');
    await ui.press('left');
    await ui.press('backspace');
    expect(ui.frame()).not.toContain('[image #');
    await ui.destroy();
  });

  it('剪贴板没有图片时提示且不插占位符', async () => {
    const { notices, ui } = await setupPaste(() => Promise.resolve(undefined));
    await ui.press('v', { ctrl: true });
    await ui.tick();
    expect(notices).toHaveLength(1);
    expect(ui.frame()).not.toContain('[image #');
    await ui.destroy();
  });

  it('未注入 readClipboardImage 时 ctrl+v 保持无动作', async () => {
    const { submitted, ui: p } = setup([]);
    const ui = await p;
    await ui.type('abc');
    await ui.press('v', { ctrl: true });
    expect(ui.frame()).not.toContain('[image #');
    await ui.press('return');
    expect(submitted).toEqual(['abc']);
    await ui.destroy();
  });
});

describe('tab 与 shift+tab 的分工', () => {
  const commands: SlashCommand[] = [
    { name: 'plan', description: '计划模式' },
    { name: 'provider', description: '切换服务商' },
  ];

  it('tab 仍然补全命令', async () => {
    const { ui: p } = setup(commands);
    const ui = await p;
    await ui.type('/pl');
    await ui.press('tab');
    expect(ui.frame()).toContain('/plan');
    await ui.destroy();
  });

  // shift+tab 是全局切权限模式的快捷键,报成 tab + shift。
  // 不排除 shift 的话,命令菜单一开它就被补全吞掉,模式永远切不动。
  it('shift+tab 不触发补全,留给全局快捷键', async () => {
    const { ui: p } = setup(commands);
    const ui = await p;
    await ui.type('/pl');
    const before = ui.frame();
    await ui.press('tab', { shift: true });
    expect(ui.frame()).toBe(before);
    await ui.destroy();
  });
});

/**
 * 列表本来就随光标滚动(8 行的窗口 + 上/下省略提示),这里补的是"用滚轮
 * 滚":滚轮与上下键共用同一份移动实现,所以行为(含首尾环绕)必须一致。
 */
describe('滚轮滚列表', () => {
  const many: SlashCommand[] = Array.from({ length: 12 }, (_, i) => ({
    name: `cmd${String(i + 1).padStart(2, '0')}`,
    description: '',
  }));

  /** 菜单里某一行的坐标。滚轮命中区是整个菜单容器,取哪一行都一样。 */
  function rowAt(frame: string, needle: string): { x: number; y: number } {
    const lines = frame.split('\n');
    const y = lines.findIndex((line) => line.includes(needle));
    expect(y, `帧里找不到 ${needle}`).toBeGreaterThanOrEqual(0);
    return { x: lines[y]!.indexOf(needle), y };
  }

  it('命令菜单:向下滚一格 = 按一次 ↓', async () => {
    const { submitted, ui: p } = setup(many);
    const ui = await p;
    await ui.type('/');
    const row = rowAt(ui.frame(), 'cmd03');

    await ui.scroll(row.x, row.y, 'down');
    await ui.press('return');

    expect(submitted).toEqual(['/cmd02']);
    await ui.destroy();
  });

  it('命令菜单:滚过头会环绕,与上下键一致', async () => {
    const { submitted, ui: p } = setup(many);
    const ui = await p;
    await ui.type('/');
    const row = rowAt(ui.frame(), 'cmd03');

    await ui.scroll(row.x, row.y, 'up'); // 从第 1 项往上 → 绕到最后一项

    await ui.press('return');
    expect(submitted).toEqual(['/cmd12']);
    await ui.destroy();
  });

  it('命令菜单:滚到窗口外时列表窗口跟着滚', async () => {
    const { ui: p } = setup(many);
    const ui = await p;
    await ui.type('/');
    const row = rowAt(ui.frame(), 'cmd03');
    // 一屏 8 项:cmd01–cmd08 可见,cmd12 在窗口外。
    expect(ui.frame()).toContain('cmd08');
    expect(ui.frame()).not.toContain('cmd12');

    for (let i = 0; i < 8; i += 1) await ui.scroll(row.x, row.y, 'down');

    const frame = ui.frame();
    expect(frame).toContain('cmd12');
    expect(frame).not.toContain('cmd01');
    await ui.destroy();
  });

  it('滚在菜单外不动光标', async () => {
    const { submitted, ui: p } = setup(many);
    const ui = await p;
    await ui.type('/');

    // 第 0 行是输入框那一块,在菜单容器之外。
    await ui.scroll(4, 0, 'down');
    await ui.press('return');

    expect(submitted).toEqual(['/cmd01']);
    await ui.destroy();
  });

  it('@ 文件菜单同样可滚', async () => {
    const files = ['src/ui/Input.tsx', 'src/agent/loop.ts', 'README.md'];
    const { submitted, ui: p } = setup([], undefined, () => Promise.resolve(files));
    const ui = await p;
    await ui.type('看看 @src');
    await ui.tick();
    const row = rowAt(ui.frame(), 'src/ui/Input.tsx');

    await ui.scroll(row.x, row.y, 'down');
    await ui.press('return'); // 插入选中项
    await ui.press('return'); // 菜单已关,这次提交

    expect(submitted).toEqual(['看看 @src/agent/loop.ts']);
    await ui.destroy();
  });

  it('二级选择器同样可滚', async () => {
    const picker: SlashCommand = {
      name: 'picker',
      description: '',
      options: () => [{ value: 'alpha' }, { value: 'beta' }, { value: 'gamma' }],
    };
    const { submitted, ui: p } = setup([picker]);
    const ui = await p;
    await ui.type('/picker');
    await ui.press('return');
    await ui.tick();
    const row = rowAt(ui.frame(), 'beta');

    await ui.scroll(row.x, row.y, 'down'); // alpha → beta
    await ui.press('return');

    expect(submitted).toEqual(['/picker beta']);
    await ui.destroy();
  });
});
