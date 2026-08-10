import { describe, expect, it, vi } from 'vitest';


import { App } from '../../src/ui/App.js';
import { stubGoal } from '../support/goal.js';
import { EventBus } from '../../src/core/events.js';
import type { Session } from '../../src/app/bootstrap.js';
import { renderUi } from '../support/otui.js';

/**
 * 覆盖 App 从事件总线到时间线的流式收尾逻辑:中断(Esc)和流级异常时
 * SDK 不会补发 text-end/reasoning-end,已生成的部分内容必须照样定稿,
 * 不能滞留在累积区被拼进下一轮。
 */
async function setup() {
  const bus = new EventBus();
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const session = {
    root: '/tmp/project',
    config: { sandbox: 'workspace-write', approval: 'untrusted', plan: false, statusBar: [] },
    provider,
    agent: {
      isRunning: false,
      inject: () => false,
      run: async () => {},
      abort: () => {},
      clear: () => {},
      compact: async () => {},
    },
    bus,
    gate: { setAsker: () => {} },
    todos: { get: () => [], subscribe: () => () => {} },
    goal: stubGoal(async () => {}),
    mcpStatuses: [],
    skills: [],
    skillsChanged: () => () => {},
    store: { id: 'test-session', messages: [] },
    switch: () => provider,
    setMode: () => {},
    dispose: async () => {},
  } as unknown as Session;

  // 全屏渲染下 frame() 只截视口:给足高度,让横幅 + 时间线全部落在视口内。
  const ui = await renderUi(() => <App session={session} />, { width: 100, height: 40 });
  return { bus, ui };
}

describe('流式中断/出错时的收尾', () => {
  it('aborted 把未定稿的文本推入时间线', async () => {
    const { bus, ui } = await setup();

    bus.emit({ type: 'text-start', id: '0' });
    bus.emit({ type: 'text-delta', id: '0', text: '这是中断前已生成的部分回答' });
    bus.emit({ type: 'aborted' });
    await ui.tick();

    expect(ui.frame()).toContain('这是中断前已生成的部分回答');
    await ui.destroy();
  });

  it('error 把未定稿的文本推入时间线,思考只留一行标记', async () => {
    const { bus, ui } = await setup();

    // 三条事件同步发出,中间没有渲染机会,因此思考正文连预览都没画过——
    // 这里的"不含正文"断言检验的正是定稿逻辑,而不是预览恰好没出现。
    bus.emit({ type: 'reasoning-delta', id: 'r0', text: '思考到一半' });
    bus.emit({ type: 'text-delta', id: '0', text: '答到一半' });
    bus.emit({ type: 'error', error: new Error('connection reset'), recoverable: true });
    await ui.tick();

    const out = ui.frame();
    // 断言字形而不是文案:测试进程的语言取自环境变量,两种目录都要能过。
    expect(out).toContain('✻');
    expect(out).not.toContain('思考到一半');
    expect(out).toContain('答到一半');
    expect(out).toContain('connection reset');
    await ui.destroy();
  });

  it('中断残留不会拼进下一轮的回答', async () => {
    const { bus, ui } = await setup();

    bus.emit({ type: 'text-delta', id: '0', text: '旧轮残留' });
    bus.emit({ type: 'aborted' });
    await ui.tick();
    bus.emit({ type: 'text-delta', id: '1', text: '新轮回答' });
    bus.emit({ type: 'text-end', id: '1' });
    await ui.tick();

    const out = ui.frame();
    expect(out).toContain('新轮回答');
    expect(out).not.toContain('旧轮残留新轮回答');
    await ui.destroy();
  });

  it('aborted 清掉进行中的工具行', async () => {
    const { bus, ui } = await setup();

    bus.emit({ type: 'tool-start', callId: 'c1', toolName: 'slowTool', input: {} });
    await ui.tick();
    expect(ui.frame()).toContain('slowTool');

    bus.emit({ type: 'aborted' });
    await ui.tick();
    expect(ui.frame()).not.toContain('slowTool');
    await ui.destroy();
  });

  it('流式中已完成的段落提前定稿,不被尾部预览裁掉', async () => {
    const { bus, ui } = await setup();

    // 首段 8 行,远超 5 行的尾部预览预算:若不增量提交,'第0行内容'
    // 在 text-end 之前不会出现在屏幕上的任何位置。
    const first = Array.from({ length: 8 }, (_, i) => `第${i}行内容`).join('\n');
    bus.emit({ type: 'text-delta', id: '0', text: `${first}\n\n尾段生成中` });
    await ui.tick();
    expect(ui.frame()).toContain('第0行内容');

    bus.emit({ type: 'text-end', id: '0' });
    await ui.tick();
    expect(ui.frame()).toContain('尾段生成中');
    await ui.destroy();
  });

  it('无切点的长代码块在流式期间完整可见(动态区并入时间线)', async () => {
    const { bus, ui } = await setup();

    // 围栏内没有可提交的切点:旧预览模式下只显示尾部 5 行,'代码第0行'
    // 在 text-end 之前不会出现;并入时间线后整块随粘底滚动完整可见。
    const block = ['```js', ...Array.from({ length: 12 }, (_, i) => `代码第${i}行`)].join('\n');
    bus.emit({ type: 'text-delta', id: '0', text: block });
    await ui.tick();

    const out = ui.frame();
    expect(out).toContain('代码第0行');
    expect(out).toContain('代码第11行');
    await ui.destroy();
  });

  it('正常 text-end 仍照常定稿(回归)', async () => {
    const { bus, ui } = await setup();

    bus.emit({ type: 'text-delta', id: '0', text: '正常结束的回答' });
    bus.emit({ type: 'text-end', id: '0' });
    bus.emit({ type: 'aborted' });
    await ui.tick();

    // text-end 已清空累积区,aborted 不会再重复推同一段:
    // 视口帧里这段文本只出现一次(时间线定稿那一条)。
    const occurrences = ui.frame().split('正常结束的回答').length - 1;
    expect(occurrences).toBe(1);
    await ui.destroy();
  });
});

describe('压缩进度', () => {
  // 回归:progress 是可选 prop,App 漏传时 typecheck 与 StatusLine 的单测
  // 都不报错,进度条却在任何路径上都出不来。这里走完整链路:总线事件 →
  // work 信号 → StatusLine 渲染。
  it('compaction-progress 事件让状态行画出进度条与百分比', async () => {
    const { bus, ui } = await setup();

    bus.emit({ type: 'compaction-progress', chars: 1500 });
    await ui.tick();

    const out = ui.frame();
    expect(out).toContain('▰');
    expect(out).toContain('50%');

    // 收尾事件:agent 空闲(isRunning=false),状态行熄灯。
    bus.emit({ type: 'compaction', removedMessages: 3, summaryChars: 1500 });
    await ui.tick();
    expect(ui.frame()).not.toContain('▰');
    await ui.destroy();
  });
});

const usage = (cumulative: number) => ({
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  cumulativeTotalTokens: cumulative,
  contextWindow: 100_000,
});

describe('一轮的收尾行', () => {
  it('正常一轮画出模型与本轮 token(累计量的增量)', async () => {
    const { bus, ui } = await setup();

    bus.emit({ type: 'turn-start', userText: '干活' });
    bus.emit({ type: 'step-end', usage: usage(5000) });
    bus.emit({ type: 'text-delta', id: '0', text: '好了' });
    bus.emit({ type: 'text-end', id: '0' });
    bus.emit({ type: 'turn-end', usage: usage(5000), finishReason: 'stop' });
    await ui.tick();

    const out = ui.frame();
    expect(out).toContain('▣');
    expect(out).toContain('test-model');
    expect(out).toContain('5.0k');
    await ui.destroy();
  });

  // `--attach` 连上跑到一半的 server,或重连时重放缓冲已滚过 turn-start,
  // 都只收得到 turn-end。那时没有基准:耗时会写成 0ms,整个会话的累计量
  // 会被当成这一轮的开销报出来——宁可不画这一行。
  it('没见过 turn-start 就不画(基准不可信)', async () => {
    const { bus, ui } = await setup();

    bus.emit({ type: 'text-delta', id: '0', text: '半路接上的回答' });
    bus.emit({ type: 'text-end', id: '0' });
    bus.emit({ type: 'turn-end', usage: usage(120_000), finishReason: 'stop' });
    await ui.tick();

    const out = ui.frame();
    expect(out).toContain('半路接上的回答');
    expect(out).not.toContain('▣');
    await ui.destroy();
  });

  it('基准一次性消费:补收到的第二条 turn-end 不借用上一轮的起点', async () => {
    const { bus, ui } = await setup();

    bus.emit({ type: 'turn-start', userText: '干活' });
    bus.emit({ type: 'turn-end', usage: usage(1000), finishReason: 'stop' });
    bus.emit({ type: 'turn-end', usage: usage(90_000), finishReason: 'stop' });
    await ui.tick();

    expect(ui.frame().split('▣').length - 1).toBe(1);
    await ui.destroy();
  });
});
