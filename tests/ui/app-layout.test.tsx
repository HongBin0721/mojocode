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

/**
 * 底部区与时间线/块与块之间的间距守卫:每条缝恰好一行,来源是底部固定区
 * 外层那一个 marginTop(见 App.tsx 的约定注释)。历史上这里叠出过双倍缝
 * ——抽出底部固定区带来外层 margin 后,InputArea/StatusLine/各覆盖层自带
 * 的顶部 margin 都没拆。任何一条缝变宽,优先怀疑有两个 margin 来源。
 */
describe('底部区间距', () => {
  const usage = (cumulative: number) => ({
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cumulativeTotalTokens: cumulative,
    contextWindow: 100_000,
  });

  /** 矮视口下让时间线溢出并粘底,最后一条内容行才会贴着底部区,缝才可测。 */
  function overflowTimeline(bus: EventBus) {
    bus.emit({ type: 'turn-start', userText: '问' });
    bus.emit({ type: 'text-start', id: '0' });
    bus.emit({ type: 'text-delta', id: '0', text: '回答正文\n'.repeat(14) });
    bus.emit({ type: 'text-end', id: '0' });
  }

  /** 视口里第一个圆角边框(输入框或覆盖层)上方、到上一条非空行之间的空白行数。 */
  function gapAboveFirstBorder(frame: string): number {
    const lines = frame.split('\n');
    const border = lines.findIndex((l, i) => i > 0 && l.includes('╭'));
    if (border <= 0) throw new Error('frame 里找不到边框');
    let last = border - 1;
    while (last >= 0 && lines[last]!.trim() === '') last--;
    return border - last - 1;
  }

  it('常态:时间线与输入框之间恰好一行', async () => {
    const session = fakeSession();
    const ui = await renderUi(() => <App session={session} />, { width: 100, height: 16 });
    overflowTimeline(session.bus);
    session.bus.emit({ type: 'turn-end', usage: usage(120), finishReason: 'stop' });
    await ui.tick();

    expect(gapAboveFirstBorder(ui.frame())).toBe(1);
    await ui.destroy();
  });

  it('任务运行中:状态行与输入框之间恰好一行', async () => {
    const session = fakeSession();
    const ui = await renderUi(() => <App session={session} />, { width: 100, height: 16 });
    overflowTimeline(session.bus); // 不发 turn-end,状态行保持亮着
    await ui.tick();

    const frame = ui.frame();
    expect(frame).toContain('responding'); // 状态行确实在场
    expect(gapAboveFirstBorder(frame)).toBe(1);
    await ui.destroy();
  });

  it('权限确认框:状态行与确认框之间恰好一行(框不再自带顶部 margin)', async () => {
    const session = fakeSession();
    const ui = await renderUi(() => <App session={session} />, { width: 100, height: 16 });
    overflowTimeline(session.bus);
    session.bus.emit({
      type: 'permission-request',
      request: { id: 'p1', toolName: 'bash', title: 'bash: npm test', risk: 'execute' },
    });
    await ui.tick();

    const frame = ui.frame();
    expect(frame).toContain('bash: npm test'); // 确认框在场(同时 work=waiting)
    expect(gapAboveFirstBorder(frame)).toBe(1);
    await ui.destroy();
  });
});
