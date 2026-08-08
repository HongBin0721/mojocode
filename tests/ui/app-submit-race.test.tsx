import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 回车之后、run() 之前的窗口:@ 引用展开是异步的,这期间 agent 仍是
 * idle。不把这段窗口算作"忙",esc 会去武装回退选择器而不是取消提交,
 * /clear 之类改写历史的命令也会绕过 busy 拦截,随后排队的这一轮再往新
 * 会话里写。用可控的 deferred 顶替展开,把这段窗口固定住来测。
 */

const { mockExpand, deferred } = vi.hoisted(() => {
  const deferred: { resolve?: (v: unknown) => void } = {};
  return {
    deferred,
    mockExpand: vi.fn(
      () =>
        new Promise((resolve) => {
          deferred.resolve = resolve;
        }),
    ),
  };
});

vi.mock('../../src/app/attachments.js', () => ({
  expandAtReferences: mockExpand,
  warnableSkips: () => [],
}));


import { App } from '../../src/ui/App.js';
import { stubGoal } from '../support/goal.js';
import { EventBus } from '../../src/core/events.js';
import type { Session } from '../../src/app/bootstrap.js';
import { renderUi } from '../support/otui.js';

async function setup(options?: { isRunning?: boolean }) {
  const bus = new EventBus();
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const runCalls: string[] = [];
  const injected: string[] = [];
  let aborts = 0;
  // /clear 走的是 session.newSession(),不是 agent.clear()。
  let newSessions = 0;
  // App 的提交路径经 goal.run,目标未激活时它原样透传到 agent.run——桩里
  // 两处共用同一个实现,断言 runCalls 与真实链路一致。
  const run = async (text: string) => {
    runCalls.push(text);
  };
  const session = {
    root: '/tmp/project',
    config: {
      sandbox: 'workspace-write',
      approval: 'untrusted',
      plan: false,
      statusBar: [],
      permissions: { denyPath: [] },
    },
    provider,
    agent: {
      isRunning: options?.isRunning ?? false,
      isCompacting: false,
      history: [],
      inject: (text: string) => {
        if (!options?.isRunning) return false;
        injected.push(text);
        return true;
      },
      run,
      abort: () => {
        aborts++;
      },
      clear: () => {},
      compact: async () => {},
    },
    bus,
    gate: { setAsker: () => {} },
    todos: { get: () => [], subscribe: () => () => {} },
    goal: stubGoal(run),
    mcpStatuses: [],
    skills: [],
    skillsChanged: () => () => {},
    store: { id: 'test-session', messages: [] },
    newSession: async () => {
      newSessions++;
      return { id: 'new-session', messages: [] };
    },
    switch: () => provider,
    setMode: () => {},
    dispose: async () => {},
  } as unknown as Session;

  const ui = await renderUi(() => <App session={session} />, { width: 100, height: 40 });
  return {
    runCalls,
    injected,
    abortCount: () => aborts,
    newSessionCount: () => newSessions,
    ui,
  };
}

beforeEach(() => {
  mockExpand.mockClear();
  delete deferred.resolve;
});

describe('提交受理后、run 发起前的窗口', () => {
  it('esc 取消这次提交,展开完成后也不再发起', async () => {
    const { runCalls, ui } = await setup();

    await ui.type('你好');
    await ui.press('return');
    expect(mockExpand).toHaveBeenCalledTimes(1);
    expect(runCalls).toEqual([]); // 还卡在展开里

    await ui.press('escape');

    deferred.resolve!({ expanded: '你好', attached: [], skipped: [], images: [] });
    await ui.tick();

    expect(runCalls).toEqual([]); // 已作废,不补发
    await ui.destroy();
  });

  it('未按 esc 时,展开完成后正常发起这一轮', async () => {
    const { runCalls, ui } = await setup();

    await ui.type('你好');
    await ui.press('return');

    deferred.resolve!({ expanded: '你好', attached: [], skipped: [], images: [] });
    await ui.tick();

    expect(runCalls).toEqual(['你好']);
    await ui.destroy();
  });

  it('这段窗口里 /clear 被 busy 拦下,不会换掉会话', async () => {
    const { newSessionCount, ui } = await setup();

    await ui.type('你好');
    await ui.press('return');

    await ui.type('/clear');
    await ui.press('return');

    expect(newSessionCount()).toBe(0);
    // 拦下时会给出"任务运行中不能使用 /clear"的提示。
    expect(ui.frame()).toContain('/clear');
    await ui.destroy();
  });

  // 运行中提交的是引导消息,此时 esc 要的是中断那一轮;只取消引导会
  // 表现为"esc 按了没反应,状态栏却灭了"。
  it('turn 正在跑时 esc 仍然中断那一轮,并作废在途的引导', async () => {
    const { abortCount, injected, ui } = await setup({ isRunning: true });

    await ui.type('顺便改下这里');
    await ui.press('return');

    await ui.press('escape');

    expect(abortCount()).toBe(1);

    deferred.resolve!({ expanded: '顺便改下这里', attached: [], skipped: [], images: [] });
    await ui.tick();
    expect(injected).toEqual([]); // 在途引导已作废
    await ui.destroy();
  });

  it('提交完成后 /clear 恢复可用(拦截不是永久的)', async () => {
    const { newSessionCount, ui } = await setup();

    await ui.type('你好');
    await ui.press('return');
    deferred.resolve!({ expanded: '你好', attached: [], skipped: [], images: [] });
    await ui.tick();

    await ui.type('/clear');
    await ui.press('return');

    expect(newSessionCount()).toBe(1);
    await ui.destroy();
  });
});
