import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import { stubGoal } from './support/goal.js';
import { EventBus } from '../src/core/events.js';
import { setLocale } from '../src/i18n/index.js';
import type { Session } from '../src/app/bootstrap.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

beforeEach(() => {
  setLocale('en');
});

function setup(overrides: { forkSession?: () => Promise<unknown>; isRunning?: boolean } = {}) {
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const forkSession =
    overrides.forkSession ?? vi.fn(async () => ({ id: 'forked-session-id', messages: [] }));
  const session = {
    root: '/tmp/project',
    config: { sandbox: 'workspace-write', approval: 'untrusted', plan: false, statusBar: [] },
    provider,
    agent: {
      isRunning: overrides.isRunning ?? false,
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
    store: { id: 'source-session-id', messages: [] },
    forkSession,
    switch: () => provider,
    setMode: () => {},
    dispose: async () => {},
  } as unknown as Session;

  const view = render(<App session={session} />);
  return { forkSession, ...view };
}

async function submit(stdin: { write: (s: string) => void }, text: string) {
  stdin.write(text);
  await tick();
  stdin.write('\r');
  await tick();
}

describe('/fork 命令', () => {
  it('调用 forkSession 并提示新旧会话 id,时间线不清空', async () => {
    const { forkSession, stdin, frames, unmount } = setup();
    await tick();
    await submit(stdin, '/fork');

    expect(forkSession).toHaveBeenCalledTimes(1);
    const out = frames.join('\n');
    expect(out).toContain('forked-session-id');
    // 源会话 id 以前缀出现在提示里(截 8 位)。
    expect(out).toContain('source-s');
    // 时间线没有被重置:横幅(工作区路径)仍在。
    expect(out).toContain('/tmp/project');
    unmount();
  });

  it('分叉失败落警告,不吞错误', async () => {
    const { stdin, frames, unmount } = setup({
      forkSession: async () => {
        throw new Error('disk full');
      },
    });
    await tick();
    await submit(stdin, '/fork');

    expect(frames.join('\n')).toContain('disk full');
    unmount();
  });

  it('agent 运行中被拦下', async () => {
    const { forkSession, stdin, frames, unmount } = setup({ isRunning: true });
    await tick();
    await submit(stdin, '/fork');

    expect(forkSession).not.toHaveBeenCalled();
    expect(frames.join('\n')).toContain('running'); // notice.busyCommand
    unmount();
  });
});
