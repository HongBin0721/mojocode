import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { App } from '../../src/ui/App.js';
import { EventBus } from '../../src/core/events.js';
import { setLocale } from '../../src/i18n/index.js';
import { theme } from '../../src/ui/theme.js';
import { applyTheme } from '../../src/ui/theme-loader.js';
import { saveTheme } from '../../src/config/save.js';
import type { Session } from '../../src/app/bootstrap.js';
import { renderUi } from '../support/otui.js';
import { stubExtensions } from '../support/extensions.js';

/**
 * `/theme <name>`:运行期换配色。主题文件在项目 `.mojocode/themes/` 下;
 * 换完 palette 那张表就地变、整树重挂但时间线不丢、落盘写顶层 `theme`。
 */
vi.mock('../../src/config/save.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/config/save.js');
  return { ...actual, saveTheme: vi.fn(async () => '/tmp/config.json') };
});

const original = { ...theme };
let root: string;

beforeEach(async () => {
  setLocale('en');
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-theme-ui-'));
  const dir = path.join(root, '.mojocode', 'themes');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'dusk.json'), JSON.stringify({ colors: { accent: '#7aa2f7' } }));
  vi.mocked(saveTheme).mockClear();
});

afterEach(async () => {
  applyTheme(original);
  await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const session = {
    root,
    config: { sandbox: 'workspace-write', approval: 'untrusted', plan: false, statusBar: [], timeline: 'full' },
    provider,
    agent: {
      isRunning: false,
      isCompacting: false,
      history: [],
      inject: () => false,
      run: async () => {},
      abort: () => {},
      clear: () => {},
      compact: async () => {},
    },
    bus: new EventBus(),
    skills: [],
    skillsChanged: () => () => {},
    ...stubExtensions(),
    store: { id: 'sess', messages: [] },
    switch: () => provider,
    setMode: () => {},
    dispose: async () => {},
  } as unknown as Session;
  const ui = await renderUi(() => <App session={session} />, { width: 100, height: 40 });
  session.bus.emit({ type: 'text-delta', id: 't1', text: '这是最终回答。' });
  session.bus.emit({ type: 'text-end', id: 't1' });
  await ui.tick();
  return { ui, session };
}

describe('/theme 运行期换色', () => {
  it('/theme <name> 就地换色、重挂后时间线仍在、落盘主题名;default 回到内置并删键', async () => {
    const { ui, session } = await setup();
    await ui.type('/theme dusk');
    await ui.press('return');
    await ui.tick();
    expect(theme.accent).toBe('#7aa2f7');
    expect(session.config.theme).toBe('dusk');
    expect(ui.frame()).toContain('Theme is now dusk.');
    expect(ui.frame()).toContain('这是最终回答。');
    expect(saveTheme).toHaveBeenLastCalledWith('dusk', root);

    await ui.type('/theme default');
    await ui.press('return');
    await ui.tick();
    expect(theme.accent).toBe(original.accent);
    expect(session.config.theme).toBeUndefined();
    expect(saveTheme).toHaveBeenLastCalledWith(undefined, root);
    await ui.destroy();
  });

  it('找不到的主题只提示,不动配色也不落盘', async () => {
    const { ui } = await setup();
    await ui.type('/theme nope');
    await ui.press('return');
    await ui.tick();
    expect(ui.frame()).toContain('Theme "nope" not found');
    expect(theme.accent).toBe(original.accent);
    expect(saveTheme).not.toHaveBeenCalled();
    await ui.destroy();
  });

  /** 当前帧里有没有前景色恰为 rgb 的 span——预览不重挂,颜色必须经响应式节点自己变过来。 */
  const paintedWith = (ui: Awaited<ReturnType<typeof setup>>['ui'], [r, g, b]: [number, number, number]) => {
    const captured = ui.spans() as { lines: { spans: { fg?: { buffer: Record<number, number> } }[] }[] };
    return captured.lines
      .flatMap((l) => l.spans)
      .some((s) => s.fg !== undefined && s.fg.buffer[0] === r && s.fg.buffer[1] === g && s.fg.buffer[2] === b);
  };

  it('选择器里光标到哪套就预览哪套,esc 收回到已提交的;回车提交后重挂,命令历史还在', async () => {
    const { ui } = await setup();
    // 先留一条历史,提交后重挂了还得翻得到。
    await ui.type('hello history');
    await ui.press('return');
    await ui.tick();

    await ui.type('/theme');
    await ui.press('return');
    await ui.tick();
    await ui.tick();
    expect(ui.frame()).toContain('dusk');
    expect(paintedWith(ui, [122, 162, 247])).toBe(false);
    await ui.press('down');
    await vi.waitFor(() => expect(theme.accent).toBe('#7aa2f7'));
    await ui.tick();
    // 选择器还开着(没重挂),画面已经是新 accent:读 theme.x 的节点自己重算了。
    expect(ui.frame()).toContain('dusk');
    expect(paintedWith(ui, [122, 162, 247])).toBe(true);
    await ui.press('escape');
    await ui.tick();
    expect(theme.accent).toBe(original.accent);
    expect(paintedWith(ui, [122, 162, 247])).toBe(false);

    // esc 只关选择器,输入框里的 `/theme` 还在:再回车即重开。
    await ui.press('return');
    await ui.tick();
    await ui.tick();
    await ui.press('down');
    await ui.press('return');
    await vi.waitFor(() => expect(ui.frame()).toContain('Theme is now dusk.'));
    expect(theme.accent).toBe('#7aa2f7');
    // 最新一条是刚提交的 `/theme dusk`,再往上才是重挂之前留下的那条。
    await ui.press('up');
    await ui.tick();
    expect(ui.frame()).toContain('/theme dusk');
    await ui.press('up');
    await ui.tick();
    expect(ui.frame()).toContain('hello history');
    await ui.destroy();
  });

  it('生效中的主题文件改了就热重载——只换色不重挂,输入框草稿还在', async () => {
    const { ui } = await setup();
    await ui.type('/theme dusk');
    await ui.press('return');
    await ui.tick();
    expect(theme.accent).toBe('#7aa2f7');
    await ui.type('draft in progress');
    await ui.tick();
    // 真 fs.watch:只能等真实事件到达;写放进重试里(理由见 theme-loader 测试)。
    const file = path.join(root, '.mojocode', 'themes', 'dusk.json');
    await vi.waitFor(
      async () => {
        await fs.writeFile(file, JSON.stringify({ colors: { accent: '#ff0000' } }));
        expect(theme.accent).toBe('#ff0000');
      },
      { timeout: 3000, interval: 150 },
    );
    await ui.tick();
    expect(paintedWith(ui, [255, 0, 0])).toBe(true);
    expect(ui.frame()).toContain('draft in progress');
    await ui.destroy();
  });
});
