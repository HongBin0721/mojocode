import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';
import { stubGoal } from '../support/goal.js';
import { EventBus } from '../../src/core/events.js';
import { setLocale } from '../../src/i18n/index.js';
import type { Session } from '../../src/app/bootstrap.js';
import type { TimelineMode } from '../../src/config/schema.js';
import { renderUi } from '../support/otui.js';

beforeEach(() => {
  setLocale('en');
});

vi.mock('../../src/config/save.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/config/save.js');
  return { ...actual, saveTimelineMode: vi.fn(async () => '/tmp/config.json') };
});

async function setup(timeline: TimelineMode = 'full') {
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const session = {
    root: '/tmp/project',
    config: { sandbox: 'workspace-write', approval: 'untrusted', plan: false, statusBar: [], timeline },
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

/** 往时间线塞一轮「用户提问 → 两个工具 → 回答」。 */
async function pushTurn(ui: Awaited<ReturnType<typeof setup>>['ui'], session: Session) {
  session.bus.emit({ type: 'turn-start', userText: '帮我查一下' });
  session.bus.emit({
    type: 'tool-start',
    callId: 'c1',
    toolName: 'read',
    input: { path: 'a.ts' },
  });
  session.bus.emit({
    type: 'tool-end',
    callId: 'c1',
    toolName: 'read',
    summary: '读了 10 行',
    output: {},
    isError: false,
    durationMs: 5,
  });
  session.bus.emit({
    type: 'tool-start',
    callId: 'c2',
    toolName: 'grep',
    input: { pattern: 'x' },
  });
  session.bus.emit({
    type: 'tool-end',
    callId: 'c2',
    toolName: 'grep',
    summary: '命中 3 处',
    output: {},
    isError: false,
    durationMs: 5,
  });
  session.bus.emit({ type: 'text-delta', id: 't1', text: '这是最终回答。' });
  session.bus.emit({ type: 'text-end', id: 't1' });
  await ui.tick();
}

describe('/focus 时间线密度', () => {
  it('ctrl+o 循环三档并在 footer 回显', async () => {
    const { ui } = await setup();
    await ui.press('o', { ctrl: true });
    expect(ui.frame()).toContain('timeline: compact');
    await ui.press('o', { ctrl: true });
    expect(ui.frame()).toContain('timeline: result');
    await ui.press('o', { ctrl: true });
    expect(ui.frame()).toContain('timeline: full');
    await ui.destroy();
  });

  it('compact 折叠工具调用为占位行,回答与提问仍在', async () => {
    const { ui, session } = await setup();
    await pushTurn(ui, session);
    expect(ui.frame()).toContain('Read(a.ts)');

    await ui.press('o', { ctrl: true }); // → compact
    const frame = ui.frame();
    expect(frame).toContain('2 tool calls collapsed');
    expect(frame).not.toContain('Read(a.ts)');
    // 铁律:问答恒可见
    expect(frame).toContain('帮我查一下');
    expect(frame).toContain('这是最终回答。');
    await ui.destroy();
  });

  it('result 只留问答,连占位行都没有', async () => {
    const { ui, session } = await setup();
    await pushTurn(ui, session);
    await ui.press('o', { ctrl: true });
    await ui.press('o', { ctrl: true }); // → result
    const frame = ui.frame();
    expect(frame).not.toContain('tool calls collapsed');
    expect(frame).not.toContain('Read(a.ts)');
    expect(frame).toContain('帮我查一下');
    expect(frame).toContain('这是最终回答。');
    await ui.destroy();
  });

  it('切回 full 时被折叠的内容原样回来(双向可逆)', async () => {
    const { ui, session } = await setup();
    await pushTurn(ui, session);
    await ui.press('o', { ctrl: true });
    expect(ui.frame()).not.toContain('Read(a.ts)');
    await ui.press('o', { ctrl: true });
    await ui.press('o', { ctrl: true }); // 回到 full
    const frame = ui.frame();
    expect(frame).toContain('Read(a.ts)');
    expect(frame).toContain('Grep');
    await ui.destroy();
  });

  it('启动档位来自配置', async () => {
    const { ui, session } = await setup('result');
    await pushTurn(ui, session);
    expect(ui.frame()).not.toContain('Read(a.ts)');
    expect(ui.frame()).toContain('这是最终回答。');
    await ui.destroy();
  });

  // /doctor 的整份报告就是一条 info 提示;藏掉它等于"敲了命令什么都没发生"。
  it('info 提示在任何档位都不隐藏', async () => {
    const { ui, session } = await setup();
    session.bus.emit({ type: 'notice', level: 'info', message: '这是一条普通提示' });
    await ui.tick();
    await ui.press('o', { ctrl: true });
    expect(ui.frame()).toContain('这是一条普通提示');
    await ui.press('o', { ctrl: true });
    expect(ui.frame()).toContain('这是一条普通提示');
    await ui.destroy();
  });

  it('/focus <mode> 直接设定档位', async () => {
    const { ui, session } = await setup();
    await pushTurn(ui, session);
    await ui.type('/focus result');
    await ui.press('return');
    await ui.tick();
    expect(ui.frame()).not.toContain('Read(a.ts)');
    expect(ui.frame()).toContain('这是最终回答。');
    await ui.destroy();
  });
});
