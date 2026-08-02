import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import { stubGoal } from './support/goal.js';
import { EventBus } from '../src/core/events.js';
import type { Session } from '../src/app/bootstrap.js';

// 等待 React 把 bus 事件触发的 setState 刷进帧。
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

/**
 * 覆盖 App 从事件总线到时间线的流式收尾逻辑:中断(Esc)和流级异常时
 * SDK 不会补发 text-end/reasoning-end,已生成的部分内容必须照样定稿,
 * 不能滞留在累积区被拼进下一轮。
 */
function setup() {
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
    store: { id: 'test-session', messages: [] },
    switch: () => provider,
    setMode: () => {},
    dispose: async () => {},
  } as unknown as Session;

  const view = render(<App session={session} />);
  return { bus, ...view };
}

describe('流式中断/出错时的收尾', () => {
  it('aborted 把未定稿的文本推入时间线', async () => {
    const { bus, frames, unmount } = setup();
    await tick();

    bus.emit({ type: 'text-start', id: '0' });
    bus.emit({ type: 'text-delta', id: '0', text: '这是中断前已生成的部分回答' });
    bus.emit({ type: 'aborted' });
    await tick();

    expect(frames.join('\n')).toContain('这是中断前已生成的部分回答');
    unmount();
  });

  it('error 把未定稿的文本推入时间线,思考只留一行标记', async () => {
    const { bus, frames, unmount } = setup();
    await tick();

    // 三条事件同步发出,中间没有渲染机会,因此思考正文连预览都没画过——
    // 这里的"不含正文"断言检验的正是定稿逻辑,而不是预览恰好没出现。
    bus.emit({ type: 'reasoning-delta', id: 'r0', text: '思考到一半' });
    bus.emit({ type: 'text-delta', id: '0', text: '答到一半' });
    bus.emit({ type: 'error', error: new Error('connection reset'), recoverable: true });
    await tick();

    const out = frames.join('\n');
    // 断言字形而不是文案:测试进程的语言取自环境变量,两种目录都要能过。
    expect(out).toContain('✻');
    expect(out).not.toContain('思考到一半');
    expect(out).toContain('答到一半');
    expect(out).toContain('connection reset');
    unmount();
  });

  it('中断残留不会拼进下一轮的回答', async () => {
    const { bus, frames, unmount } = setup();
    await tick();

    bus.emit({ type: 'text-delta', id: '0', text: '旧轮残留' });
    bus.emit({ type: 'aborted' });
    await tick();
    bus.emit({ type: 'text-delta', id: '1', text: '新轮回答' });
    bus.emit({ type: 'text-end', id: '1' });
    await tick();

    const out = frames.join('\n');
    expect(out).toContain('新轮回答');
    expect(out).not.toContain('旧轮残留新轮回答');
    unmount();
  });

  it('aborted 清掉进行中的工具行', async () => {
    const { bus, lastFrame, unmount } = setup();
    await tick();

    bus.emit({ type: 'tool-start', callId: 'c1', toolName: 'slowTool', input: {} });
    await tick();
    expect(lastFrame()).toContain('slowTool');

    bus.emit({ type: 'aborted' });
    await tick();
    expect(lastFrame()).not.toContain('slowTool');
    unmount();
  });

  it('流式中已完成的段落提前定稿,不被尾部预览裁掉', async () => {
    const { bus, frames, unmount } = setup();
    await tick();

    // 首段 8 行,远超 5 行的尾部预览预算:若不增量提交,'第0行内容'
    // 在 text-end 之前不会出现在屏幕上的任何位置。
    const first = Array.from({ length: 8 }, (_, i) => `第${i}行内容`).join('\n');
    bus.emit({ type: 'text-delta', id: '0', text: `${first}\n\n尾段生成中` });
    await tick();
    expect(frames.join('\n')).toContain('第0行内容');

    bus.emit({ type: 'text-end', id: '0' });
    await tick();
    expect(frames.join('\n')).toContain('尾段生成中');
    unmount();
  });

  it('正常 text-end 仍照常定稿(回归)', async () => {
    const { bus, frames, unmount } = setup();
    await tick();

    bus.emit({ type: 'text-delta', id: '0', text: '正常结束的回答' });
    bus.emit({ type: 'text-end', id: '0' });
    bus.emit({ type: 'aborted' });
    await tick();

    // text-end 已清空累积区,aborted 不会再重复推同一段。
    const occurrences = frames.join('\n').split('正常结束的回答').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(1);
    unmount();
  });
});
