import stringWidth from 'string-width';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../src/ui/App.js';
import { EventBus } from '../../src/core/events.js';
import { setLocale } from '../../src/i18n/index.js';
import type { Session } from '../../src/app/bootstrap.js';
import { renderUi } from '../support/otui.js';
import { stubExtensions } from '../support/extensions.js';

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
    skills: [],
    skillsChanged: () => () => {},
    ...stubExtensions(),
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
    // 提示符那行及其正下方的底边线都在帧里(边线被裁掉 = 输入不可见)
    const lines = frame.split('\n');
    const prompt = lines.findIndex((l) => l.includes('›'));
    expect(prompt).toBeGreaterThan(0);
    expect(lines[prompt + 1]).toMatch(/^─+$/);
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
  const WIDTH = 100;
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

  /**
   * 一行是不是底部区的边线:输入框的顶边(空闲纯线 / 工作状态线)铺满整行,
   * 时间线里的 `── 分隔 ──` 不满行,不会误判;覆盖层则是圆角框。
   */
  const isEdge = (line: string) =>
    line.includes('╭') || (line.startsWith('─') && stringWidth(line) >= WIDTH);

  /** 视口里第一条边线上方、到上一条非空行之间的空白行数。 */
  function gapAboveFirstBorder(frame: string): number {
    const lines = frame.split('\n');
    const border = lines.findIndex((l, i) => i > 0 && isEdge(l));
    if (border <= 0) throw new Error('frame 里找不到边框');
    let last = border - 1;
    while (last >= 0 && lines[last]!.trim() === '') last--;
    return border - last - 1;
  }

  it('常态:时间线与输入框之间恰好一行', async () => {
    const session = fakeSession();
    const ui = await renderUi(() => <App session={session} />, { width: WIDTH, height: 16 });
    overflowTimeline(session.bus);
    session.bus.emit({ type: 'turn-end', usage: usage(120), finishReason: 'stop' });
    await ui.tick();

    expect(gapAboveFirstBorder(ui.frame())).toBe(1);
    await ui.destroy();
  });

  it('任务运行中:状态线就是输入框的顶边,与时间线之间恰好一行', async () => {
    const session = fakeSession();
    const ui = await renderUi(() => <App session={session} />, { width: WIDTH, height: 16 });
    overflowTimeline(session.bus); // 不发 turn-end,状态行保持亮着
    await ui.tick();

    const frame = ui.frame();
    expect(frame).toContain('responding'); // 状态行确实在场
    expect(gapAboveFirstBorder(frame)).toBe(1);
    // 状态嵌在顶边线里,正下方就是提示符那行——中间没有缝。
    const lines = frame.split('\n');
    const edge = lines.findIndex((l, i) => i > 0 && isEdge(l));
    expect(lines[edge]).toMatch(/^── .*responding.* ─+$/);
    expect(lines[edge + 1]).toContain('›');
    await ui.destroy();
  });

});
