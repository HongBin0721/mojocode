import { describe, expect, it, vi } from 'vitest';


import { App } from '../../src/ui/App.js';
import { stubGoal } from '../support/goal.js';
import { RewindPicker } from '../../src/ui/RewindPicker.js';
import { EventBus } from '../../src/core/events.js';
import type { Session } from '../../src/app/bootstrap.js';
import type { ModelMessage } from 'ai';
import { renderUi } from '../support/otui.js';

// 注:旧版还有一组「终端 resize 触发清屏重放」测试(断言 \x1b[2J\x1b[3J\x1b[H
// 清屏序列)。全屏 OpenTUI 渲染下该机制已整体移除——渲染器每帧整屏重画,
// 宽度变化不再需要清屏重放,那组测试随之删除,不做移植。

function makeSession(messages: ModelMessage[]): Session {
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  return {
    root: '/tmp/project',
    config: { sandbox: 'workspace-write', approval: 'untrusted', plan: false, statusBar: [] },
    provider,
    agent: {
      isRunning: false,
      isCompacting: false,
      history: messages,
      inject: () => false,
      run: async () => {},
      abort: () => {},
      clear: () => {},
      setHistory: () => {},
      compact: async () => {},
    },
    bus: new EventBus(),
    gate: { setAsker: () => {} },
    todos: { get: () => [], subscribe: () => () => {} },
    goal: stubGoal(async () => {}),
    mcpStatuses: [],
    skills: [],
    skillsChanged: () => () => {},
    store: { id: 'resumed-session-id', messages },
    switch: () => provider,
    setMode: () => {},
    dispose: async () => {},
  } as unknown as Session;
}

describe('恢复会话的时间线回放', () => {
  it('首帧包含横幅、divider 与回放的历史内容,横幅在最顶部', async () => {
    const session = makeSession([
      { role: 'user', content: '之前的问题' },
      { role: 'assistant', content: '之前的回答' },
    ] as ModelMessage[]);

    // 视口帧只截 width×height:给足高度让横幅与全部回放内容同屏。
    const ui = await renderUi(() => <App session={session} />, { width: 100, height: 50 });

    const out = ui.frame();
    expect(out).toContain('resumed'); // divider 带会话 id 前缀
    expect(out).toContain('之前的问题');
    expect(out).toContain('之前的回答');
    // 横幅是时间线的第一条,打在回放内容之前。
    expect(out).toContain('/tmp/project');
    expect(out.indexOf('/tmp/project')).toBeLessThan(out.indexOf('resumed'));
    await ui.destroy();
  });

  it('空会话不产生 divider,横幅照常显示', async () => {
    const session = makeSession([]);
    const ui = await renderUi(() => <App session={session} />, { width: 100, height: 40 });
    const out = ui.frame();
    expect(out).not.toContain('resumed');
    expect(out).toContain('/tmp/project');
    await ui.destroy();
  });
});

describe('RewindPicker', () => {
  const entries = [
    { index: 5, ordinal: 3, text: '第三问' },
    { index: 3, ordinal: 2, text: '第二问' },
    { index: 1, ordinal: 1, text: '第一问' },
  ];

  it('回车选中当前项', async () => {
    const onPick = vi.fn();
    const ui = await renderUi(
      () => <RewindPicker entries={entries} onPick={onPick} onCancel={() => {}} />,
      { width: 60, height: 12 },
    );
    await ui.press('down'); // ↓ 到第二项
    await ui.press('return');
    expect(onPick).toHaveBeenCalledWith(entries[1]);
    await ui.destroy();
  });

  it('esc 取消', async () => {
    const onCancel = vi.fn();
    const ui = await renderUi(
      () => <RewindPicker entries={entries} onPick={() => {}} onCancel={onCancel} />,
      { width: 60, height: 12 },
    );
    await ui.press('escape');
    expect(onCancel).toHaveBeenCalled();
    await ui.destroy();
  });

  it('列表最新在前渲染', async () => {
    const ui = await renderUi(
      () => <RewindPicker entries={entries} onPick={() => {}} onCancel={() => {}} />,
      { width: 60, height: 12 },
    );
    const out = ui.frame();
    expect(out.indexOf('第三问')).toBeLessThan(out.indexOf('第一问'));
    await ui.destroy();
  });
});
