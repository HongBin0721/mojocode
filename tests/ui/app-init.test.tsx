import { describe, expect, it, vi } from 'vitest';


import { App } from '../../src/ui/App.js';
import { stubGoal } from '../support/goal.js';
import { EventBus } from '../../src/core/events.js';
import { INIT_PROMPT } from '../../src/agent/init.js';
import { t } from '../../src/i18n/index.js';
import type { Session } from '../../src/app/bootstrap.js';
import { renderUi } from '../support/otui.js';

/**
 * 覆盖 /init 命令:它是唯一发起完整 agent 轮的斜杠命令——完整指令喂给
 * 模型,时间线只回显 `/init`(turn-start 的 display),轮后刷新环境信息。
 */
async function setup(
  agentOverrides: Record<string, unknown> = {},
  sessionOverrides: {
    sandbox?: string;
    approval?: string;
    plan?: boolean;
    refreshEnvironment?: () => Promise<void>;
  } = {},
) {
  const bus = new EventBus();
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const run = vi.fn(async () => {});
  const refreshEnvironment = vi.fn(sessionOverrides.refreshEnvironment ?? (async () => {}));
  const session = {
    root: '/tmp/project',
    config: {
      sandbox: sessionOverrides.sandbox ?? 'workspace-write',
      approval: sessionOverrides.approval ?? 'untrusted',
      plan: sessionOverrides.plan ?? false,
      statusBar: [],
    },
    provider,
    agent: {
      isRunning: false,
      isCompacting: false,
      inject: () => false,
      run,
      abort: () => {},
      clear: () => {},
      compact: async () => {},
      ...agentOverrides,
    },
    bus,
    gate: { setAsker: () => {} },
    todos: { get: () => [], subscribe: () => () => {} },
    goal: stubGoal(run),
    mcpStatuses: [],
    store: { id: 'test-session', messages: [] },
    switch: () => provider,
    setMode: () => {},
    refreshEnvironment,
    dispose: async () => {},
  } as unknown as Session;

  const ui = await renderUi(() => <App session={session} />, { width: 100, height: 45 });
  const submit = async (text: string) => {
    await ui.type(text);
    await ui.press('return');
    // run().then(refreshEnvironment) 是异步链,多让一拍再断言。
    await ui.tick();
  };
  return { bus, run, refreshEnvironment, submit, ui };
}

describe('/init 命令', () => {
  it('提交 /init:完整指令进 run,display 为 /init,轮后刷新环境', async () => {
    const { submit, run, refreshEnvironment, ui } = await setup();

    await submit('/init');

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(INIT_PROMPT, { display: '/init' });
    expect(refreshEnvironment).toHaveBeenCalledTimes(1);
    // 指令正文不允许出现在时间线(只回显 /init)。
    expect(ui.frame()).not.toContain('agent audience');
    await ui.destroy();
  });

  it('turn-start 带 display 时时间线显示 display 而非完整指令', async () => {
    const { bus, ui } = await setup();

    bus.emit({ type: 'turn-start', userText: '很长很长的 init 指令正文', display: '/init' });
    await ui.tick();

    const out = ui.frame();
    expect(out).toContain('/init');
    expect(out).not.toContain('很长很长的 init 指令正文');
    await ui.destroy();
  });

  it('不带 display 的 turn-start 仍回显 userText(回归)', async () => {
    const { bus, ui } = await setup();

    bus.emit({ type: 'turn-start', userText: '普通的用户消息' });
    await ui.tick();

    expect(ui.frame()).toContain('普通的用户消息');
    await ui.destroy();
  });

  // 提示语按框宽折行,断言取不会被折断的片段,而不是整条消息。
  it('readonly 模式提前拦下,不白烧一轮', async () => {
    const { submit, run, ui } = await setup({}, { sandbox: 'read-only', approval: 'never' });

    await submit('/init');

    expect(run).not.toHaveBeenCalled();
    expect(ui.frame()).toContain('/init needs to write AGENTS.md');
    expect(ui.frame()).toContain('refuses every write');
    await ui.destroy();
  });

  // plan 与 readonly 一样硬拒写入,这一轮同样注定写不出 AGENTS.md。
  it('plan 模式同样提前拦下', async () => {
    const { submit, run, ui } = await setup({}, { plan: true });

    await submit('/init');

    expect(run).not.toHaveBeenCalled();
    expect(ui.frame()).toContain('refuses every write');
    await ui.destroy();
  });

  it('refreshEnvironment 失败只提示,不产生未捕获的 rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on('unhandledRejection', onRejection);

    const { submit, ui } = await setup(
      {},
      {
        refreshEnvironment: async () => {
          throw new Error('环境读取炸了');
        },
      },
    );

    await submit('/init');
    await ui.tick();

    process.off('unhandledRejection', onRejection);
    expect(rejections).toEqual([]);
    expect(ui.frame()).toContain('环境读取炸了');
    await ui.destroy();
  });

  it('agent 运行中提交 /init 被拒,不会降级为引导注入', async () => {
    const { submit, run, ui } = await setup({ isRunning: true });

    await submit('/init');

    expect(run).not.toHaveBeenCalled();
    expect(ui.frame()).toContain(t('notice.busyCommand', { name: 'init' }));
    await ui.destroy();
  });
});
