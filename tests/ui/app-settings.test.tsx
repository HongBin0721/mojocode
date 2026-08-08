import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';
import { stubGoal } from '../support/goal.js';
import { EventBus } from '../../src/core/events.js';
import { setLocale } from '../../src/i18n/index.js';
import type { Session } from '../../src/app/bootstrap.js';
import type { StatusSegment } from '../../src/config/schema.js';
import { renderUi } from '../support/otui.js';

beforeEach(() => {
  setLocale('en');
});

// 落盘必须 mock:真实实现写的是 ~/.mojocode/config.json。
vi.mock('../../src/config/save.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/config/save.js');
  return {
    ...actual,
    saveLanguage: vi.fn(async () => '/tmp/config.json'),
    saveStatusBar: vi.fn(async () => '/tmp/config.json'),
  };
});

async function setup(statusBar: StatusSegment[] = []) {
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const session = {
    root: '/tmp/project',
    config: { sandbox: 'workspace-write', approval: 'untrusted', plan: false, statusBar, timeline: 'full' },
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
    gate: { setAsker: () => {} },
    todos: { get: () => [], subscribe: () => () => {} },
    goal: stubGoal(async () => {}),
    mcpStatuses: [],
    store: { id: 'sess', messages: [] },
    switch: () => provider,
    setMode: () => {},
    dispose: async () => {},
  } as unknown as Session;
  const ui = await renderUi(() => <App session={session} />, { width: 100, height: 40 });
  return { ui, session };
}

/** 敲 `/setting` 并回车打开面板。 */
async function openPanel(ui: Awaited<ReturnType<typeof setup>>['ui']) {
  await ui.type('/setting');
  await ui.press('return');
  await ui.tick();
}

describe('/setting 设置面板', () => {
  it('打开后列出各设置项及当前值', async () => {
    const { ui } = await setup(['model', 'cwd']);
    await openPanel(ui);
    const frame = ui.frame();
    expect(frame).toContain('Settings');
    expect(frame).toContain('Language');
    expect(frame).toContain('English');
    expect(frame).toContain('Status bar');
    expect(frame).toContain('model cwd');
    await ui.destroy();
  });

  it('esc 关闭面板,输入框回来', async () => {
    const { ui } = await setup();
    await openPanel(ui);
    expect(ui.frame()).toContain('Settings');
    await ui.press('escape');
    expect(ui.frame()).not.toContain('Settings');
    expect(ui.frame()).toContain('ask anything');
    await ui.destroy();
  });

  it('语言项进二级后选中即切换整套界面文案', async () => {
    const { ui } = await setup();
    await openPanel(ui);
    await ui.press('return'); // 进「Language」
    expect(ui.frame()).toContain('简体中文');
    await ui.press('down'); // en → zh-CN
    await ui.press('return');
    const frame = ui.frame();
    expect(frame).toContain('语言已切换为 zh-CN。');
    // 面板自己的标题(重挂载后才会重新求值的静态文案)。
    expect(frame).toContain('设置');
    expect(frame).toContain('状态栏');
    // 这一条才是真正锁住「整棵界面树按 locale 重挂载」的断言:横幅的提示行
    // 画在时间线里,不在任何会因面板状态变化而重新求值的分支上——只有重挂载
    // 发生了它才会变成中文。App 末尾那个 keyed Show 的回调一旦退回零元箭头
    // (Solid 据 children.length 决定要不要按值调用),这里立刻红。
    expect(frame).toContain('/ 查看命令 · shift+tab 切权限模式');
    await ui.destroy();
  });

  it('二级里 esc 只退回一级,不关闭面板', async () => {
    const { ui } = await setup();
    await openPanel(ui);
    await ui.press('return');
    expect(ui.frame()).toContain('English');
    await ui.press('escape');
    const frame = ui.frame();
    expect(frame).toContain('Settings');
    expect(frame).toContain('Status bar');
    // 一级列表:光标回到刚进入的那一项。
    expect(frame).toContain('❯ Language');
    await ui.destroy();
  });

  it('状态栏项空格勾选、回车落地到底栏', async () => {
    const { ui } = await setup();
    await openPanel(ui);
    await ui.press('down'); // → Status bar
    await ui.press('return');
    expect(ui.frame()).toContain('Current permission mode');
    await ui.type(' '); // 勾选 mode
    await ui.press('down');
    await ui.type(' '); // 勾选 model
    await ui.press('return');
    expect(ui.frame()).toContain('Status bar now shows: mode model.');
    await ui.press('escape'); // 关闭面板,底栏回来
    const frame = ui.frame();
    expect(frame).toContain('test-model');
    await ui.destroy();
  });

  it('二级里 esc 丢弃未确认的勾选', async () => {
    const { ui } = await setup(['model']);
    await openPanel(ui);
    await ui.press('down');
    await ui.press('return');
    await ui.type(' '); // 勾上 mode(尚未确认)
    await ui.press('escape');
    // 一级列表显示的仍是原值。
    expect(ui.frame()).toContain('model');
    expect(ui.frame()).not.toContain('mode model');
    await ui.destroy();
  });
});
