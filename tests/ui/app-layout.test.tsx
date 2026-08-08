import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../src/ui/App.js';
import { stubGoal } from '../support/goal.js';
import { EventBus } from '../../src/core/events.js';
import { setLocale } from '../../src/i18n/index.js';
import type { Session } from '../../src/app/bootstrap.js';
import { renderUi } from '../support/otui.js';

beforeEach(() => {
  setLocale('en');
});

function fakeSession() {
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  return {
    root: '/tmp/project',
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
    gate: { setAsker: () => {} },
    todos: { get: () => [], subscribe: () => () => {} },
    goal: stubGoal(async () => {}),
    mcpStatuses: [],
    skills: [],
    skillsChanged: () => () => {},
    store: { id: 'sess', messages: [] },
    switch: () => provider,
    setMode: () => {},
    dispose: async () => {},
  } as unknown as Session;
}

// 矮终端保障:底部固定区 flexShrink=0,空间不足时塌缩的是时间线视口,
// 输入框(和权限选项)必须始终可见。回归:迁移曾删掉 RESERVED_ROWS 预算,
// 双预览 + 输入框在 12 行终端上会把输入框压出屏幕。
describe('矮终端布局', () => {
  it('12 行终端 + 双流式预览激活时,输入框仍然可见', async () => {
    const session = fakeSession();
    const ui = await renderUi(() => <App session={session} />, { width: 60, height: 12 });
    // 激活双预览(思考 + 正文),各来一大段
    session.bus.emit({ type: 'reasoning-delta', id: 'r1', text: '思考内容\n'.repeat(20) });
    session.bus.emit({ type: 'text-delta', id: 't1', text: '流式回答内容\n'.repeat(20) });
    await ui.tick();
    const frame = ui.frame();
    // 输入框的圆角下边框在帧里(边框被裁掉 = 输入不可见)
    expect(frame).toContain('╰');
    expect(frame).toContain('›');
    await ui.destroy();
  });

  it('8 行极矮终端上权限确认框的选项可见', async () => {
    const session = fakeSession();
    const ui = await renderUi(() => <App session={session} />, { width: 60, height: 14 });
    session.bus.emit({
      type: 'permission-request',
      request: { id: 'p1', toolName: 'bash', title: 'bash: npm test', risk: 'execute' },
    });
    await ui.tick();
    const frame = ui.frame();
    expect(frame).toContain('bash: npm test');
    expect(frame).toContain('❯');
    await ui.destroy();
  });
});
