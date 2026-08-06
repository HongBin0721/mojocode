import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import { stubGoal } from './support/goal.js';
import { RewindPicker } from '../src/ui/RewindPicker.js';
import { EventBus } from '../src/core/events.js';
import type { Session } from '../src/app/bootstrap.js';
import type { ModelMessage } from 'ai';

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

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

    const { frames, unmount } = render(<App session={session} />);
    await tick();

    const out = frames.join('\n');
    expect(out).toContain('resumed'); // divider 带会话 id 前缀
    expect(out).toContain('之前的问题');
    expect(out).toContain('之前的回答');
    // 横幅是第一条 Static 条目,打在回放内容之前。
    expect(out).toContain('/tmp/project');
    expect(out.indexOf('/tmp/project')).toBeLessThan(out.indexOf('resumed'));
    unmount();
  });

  it('空会话不产生 divider,横幅照常显示', async () => {
    const session = makeSession([]);
    const { frames, unmount } = render(<App session={session} />);
    await tick();
    const out = frames.join('\n');
    expect(out).not.toContain('resumed');
    expect(out).toContain('/tmp/project');
    unmount();
  });
});

describe('终端宽度变化的时间线重放', () => {
  it('拖动开始清屏、尾部条目转入动态区保持可见,停稳后放回 <Static>,高度变化不触发', async () => {
    const session = makeSession([
      { role: 'user', content: '之前的问题' },
      { role: 'assistant', content: '之前的回答' },
    ] as ModelMessage[]);
    const { frames, stdout, lastFrame, unmount } = render(<App session={session} />);
    await tick();
    const before = frames.length;

    // 只变高度(列数没变):不清屏、不重放。
    stdout.emit('resize');
    await tick();
    expect(frames.slice(before).join('')).not.toContain('\x1b[2J');

    // 首次宽度变化:立即清屏(2J 清屏、3J 清回滚),时间线从 <Static> 摘下、
    // 尾部条目转入动态区——拖动期间内容仍然可见。
    // (ink-testing-library 以 debug 模式跑 ink,每帧都带上 fullStaticOutput,
    // 断言"最新一帧"才对应拖动期间的实际渲染。)
    Object.defineProperty(stdout, 'columns', { value: 60, configurable: true });
    stdout.emit('resize');
    await tick();
    expect(frames.slice(before).join('\n')).toContain('\x1b[2J\x1b[3J\x1b[H');
    expect(lastFrame()).toContain('之前的问题');
    expect(lastFrame()).toContain('之前的回答');

    // 拖动中继续变宽度:动态区随重渲染跟进,内容持续可见。
    Object.defineProperty(stdout, 'columns', { value: 50, configurable: true });
    stdout.emit('resize');
    await tick();
    expect(lastFrame()).toContain('之前的回答');

    // 停稳后:再清屏一次,全部条目按最终宽度重放回 <Static>。
    const mid = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(frames.slice(mid).join('\n')).toContain('\x1b[2J\x1b[3J\x1b[H');
    expect(lastFrame()).toContain('之前的问题');
    expect(lastFrame()).toContain('之前的回答');
    unmount();
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
    const { stdin, unmount } = render(
      <RewindPicker entries={entries} onPick={onPick} onCancel={() => {}} />,
    );
    await tick();
    stdin.write('[B'); // ↓ 到第二项
    await tick();
    stdin.write('\r');
    await tick();
    expect(onPick).toHaveBeenCalledWith(entries[1]);
    unmount();
  });

  it('esc 取消', async () => {
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      <RewindPicker entries={entries} onPick={() => {}} onCancel={onCancel} />,
    );
    await tick();
    stdin.write('');
    await tick();
    expect(onCancel).toHaveBeenCalled();
    unmount();
  });

  it('列表最新在前渲染', async () => {
    const { lastFrame, unmount } = render(
      <RewindPicker entries={entries} onPick={() => {}} onCancel={() => {}} />,
    );
    await tick();
    const out = lastFrame()!;
    expect(out.indexOf('第三问')).toBeLessThan(out.indexOf('第一问'));
    unmount();
  });
});
