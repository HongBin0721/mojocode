import { beforeEach, describe, expect, it, vi } from 'vitest';


import { App } from '../../src/ui/App.js';
import { stubGoal } from '../support/goal.js';
import { EventBus } from '../../src/core/events.js';
import { setLocale } from '../../src/i18n/index.js';
import type { Session } from '../../src/app/bootstrap.js';
import { renderUi, type UiHandle } from '../support/otui.js';

beforeEach(() => {
  setLocale('en');
});

async function setup(overrides: { forkSession?: () => Promise<unknown>; isRunning?: boolean } = {}) {
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
    skills: [],
    skillsChanged: () => () => {},
    store: { id: 'source-session-id', messages: [] },
    forkSession,
    switch: () => provider,
    setMode: () => {},
    dispose: async () => {},
  } as unknown as Session;

  const ui = await renderUi(() => <App session={session} />, { width: 100, height: 40 });
  return { forkSession, ui };
}

/** forkSession 是异步命令,回车后多等一拍再断言。 */
async function submit(ui: UiHandle, text: string): Promise<void> {
  await ui.type(text);
  await ui.press('return');
  await new Promise((resolve) => setTimeout(resolve, 30));
  await ui.tick();
}

describe('/fork 命令', () => {
  it('调用 forkSession 并提示新旧会话 id,时间线不清空', async () => {
    const { forkSession, ui } = await setup();
    await submit(ui, '/fork');

    expect(forkSession).toHaveBeenCalledTimes(1);
    const out = ui.frame();
    expect(out).toContain('forked-session-id');
    // 源会话 id 以前缀出现在提示里(截 8 位)。
    expect(out).toContain('source-s');
    // 时间线没有被重置:横幅(工作区路径)仍在。
    expect(out).toContain('/tmp/project');
    await ui.destroy();
  });

  it('分叉失败落警告,不吞错误', async () => {
    const { ui } = await setup({
      forkSession: async () => {
        throw new Error('disk full');
      },
    });
    await submit(ui, '/fork');

    expect(ui.frame()).toContain('disk full');
    await ui.destroy();
  });

  it('agent 运行中被拦下', async () => {
    const { forkSession, ui } = await setup({ isRunning: true });
    await submit(ui, '/fork');

    expect(forkSession).not.toHaveBeenCalled();
    expect(ui.frame()).toContain('running'); // notice.busyCommand
    await ui.destroy();
  });
});
