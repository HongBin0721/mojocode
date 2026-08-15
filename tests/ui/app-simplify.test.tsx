import { describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';
import { stubGoal } from '../support/goal.js';
import { EventBus } from '../../src/core/events.js';
import { t } from '../../src/i18n/index.js';
import type { Session } from '../../src/app/bootstrap.js';
import { renderUi } from '../support/otui.js';

/**
 * 覆盖 /simplify 的 UI 面:裸命令默认未提交改动、任意文本作清理目标、
 * 计划模式与 read-only+never 的前置闸、半截关键字与失败 reason 的本地化。
 * 提示词组稿在 server 侧(bootstrap.startSimplify),UI 只负责流转与提示。
 */
async function setup(
  sessionOverrides: {
    plan?: boolean;
    sandbox?: string;
    approval?: string;
    isRunning?: boolean;
    startSimplify?: () => Promise<{ ok: boolean; reason?: string; branch?: string; sha?: string; detail?: string }>;
  } = {},
) {
  const bus = new EventBus();
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  // 提交路径的终点是 goal.run(无目标时透传 agent.run):普通消息有没有
  // 另起一轮,看这个 spy 最直接。
  const goalRun = vi.fn(async () => {});
  const startSimplify = vi.fn(
    sessionOverrides.startSimplify ??
      (async (targetArg: string, options?: { display?: string }) => {
        // 模拟 server 侧真实行为:罐装提示词只以 display 回显进时间线。
        bus.emit({
          type: 'turn-start',
          userText: 'Clean up the changes described below and apply the fixes yourself.',
          display: options?.display ?? (targetArg.trim() ? `/simplify ${targetArg.trim()}` : '/simplify'),
        });
        return { ok: true };
      }),
  );
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
      isRunning: sessionOverrides.isRunning ?? false,
      isCompacting: false,
      inject: () => false,
      run: vi.fn(async () => {}),
      abort: () => {},
      clear: () => {},
      compact: async () => {},
    },
    bus,
    gate: { setAsker: () => {} },
    todos: { get: () => [], subscribe: () => () => {} },
    goal: stubGoal(goalRun),
    mcpStatuses: [],
    skills: [],
    skillsChanged: () => () => {},
    store: { id: 'test-session', messages: [] },
    startSimplify,
    switch: () => provider,
    refreshEnvironment: async () => {},
    dispose: async () => {},
  } as unknown as Session;

  const ui = await renderUi(() => <App session={session} />, { width: 100, height: 45 });
  const submit = async (text: string) => {
    await ui.type(text);
    await ui.press('return');
    await ui.tick();
  };
  return { startSimplify, submit, ui, goalRun };
}

describe('/simplify 流转', () => {
  it('裸 /simplify(菜单回车)默认未提交改动,display 不带尾随空格', async () => {
    const { startSimplify, submit, ui } = await setup();
    // 菜单路径:输入 /simplify 回车提交的是裸命令本体。display 由 server 侧
    // 组装(mock 按真实行为回退),UI 不再自己拼一份。
    await ui.type('/simplify');
    await ui.press('return');
    await ui.tick();
    expect(startSimplify).toHaveBeenCalledWith('');
    const final = ui.frame();
    expect(final).toContain('/simplify');
    expect(final).not.toContain('Clean up the changes described below');
    await ui.destroy();
  });

  it('范围语法直打透传;任意文本(路径/焦点)作为清理目标', async () => {
    const a = await setup();
    await a.submit('/simplify base feature');
    expect(a.startSimplify).toHaveBeenCalledWith('base feature');
    await a.ui.destroy();

    const b = await setup();
    await b.submit('/simplify src/foo.ts');
    expect(b.startSimplify).toHaveBeenCalledWith('src/foo.ts');
    await b.ui.destroy();

    const c = await setup();
    await c.submit('/simplify commit abc1234');
    expect(c.startSimplify).toHaveBeenCalledWith('commit abc1234');
    await c.ui.destroy();
  });

  it('运行中被 busy 拦;半截关键字给用法提示', async () => {
    const busy = await setup({ isRunning: true });
    await busy.submit('/simplify');
    expect(busy.startSimplify).not.toHaveBeenCalled();
    expect(busy.ui.frame()).toContain(t('notice.busyCommand', { name: 'simplify' }));
    await busy.ui.destroy();

    const half = await setup();
    // 尾随空格:避免菜单劫持;base 裸打要跟分支,这里测的是半截关键字。
    await half.submit('/simplify base ');
    expect(half.startSimplify).not.toHaveBeenCalled();
    expect(half.ui.frame()).toContain(t('notice.simplifyUsage'));
    await half.ui.destroy();
  });

  it('计划模式与 read-only+never 提前拦下,并给出对应提示', async () => {
    const plan = await setup({ plan: true });
    await plan.submit('/simplify ');
    expect(plan.startSimplify).not.toHaveBeenCalled();
    expect(plan.ui.frame()).toContain(t('notice.simplifyPlanMode'));
    await plan.ui.destroy();

    const locked = await setup({ sandbox: 'read-only', approval: 'never' });
    await locked.submit('/simplify ');
    expect(locked.startSimplify).not.toHaveBeenCalled();
    // 提示语按框宽折行,断言取不会被折断的片段(app-init.test.ts 的同一教训)。
    expect(locked.ui.frame()).toContain('refuses every write');
    expect(locked.ui.frame()).toContain('read-only·never');
    await locked.ui.destroy();

    // read-only + on-request 放行:写入可以逐次升级确认。
    const ask = await setup({ sandbox: 'read-only', approval: 'on-request' });
    await ask.submit('/simplify ');
    expect(ask.startSimplify).toHaveBeenCalledWith('');
    await ask.ui.destroy();
  });

  it('阶段一窗口(主 agent 空闲)普通消息被拒:不另起一轮,窗口收尾后恢复', async () => {
    // 可控的 deferred:startSimplify 挂起即阶段一窗口——cannedLaunchPending
    // 置位而 agent.isRunning 仍为 false(跑的是子代理,主 agent 空闲)。窗口
    // 不修的话,普通消息会清掉 submitPending 重开 busy 门,并经 goal.run
    // 另起一轮;阶段二的应用轮提示词随后撞上防重入兜底整份灌进用户那轮。
    let release!: () => void;
    const pending = new Promise<{ ok: boolean }>((resolve) => {
      release = () => resolve({ ok: true });
    });
    const ctx = await setup({ startSimplify: (async () => pending) as never });
    await ctx.submit('/simplify ');
    await ctx.submit('趁清理跑着插一条普通消息');

    expect(ctx.ui.frame()).toContain(t('notice.cannedBusy'));
    expect(ctx.goalRun).not.toHaveBeenCalled();

    // 窗口收尾(阶段二开始)后,提交恢复为正常路径。
    release();
    await ctx.ui.tick();
    await ctx.submit('窗口结束后再发');
    expect(ctx.goalRun).toHaveBeenCalledTimes(1);
    await ctx.ui.destroy();
  });

  it('失败 reason 映射清理措辞的本地化提示(干净树为 info,其余为 warn)', async () => {
    const clean = await setup({
      startSimplify: (async () => ({ ok: false, reason: 'clean-tree' })) as never,
    });
    await clean.submit('/simplify ');
    expect(clean.ui.frame()).toContain(t('notice.simplifyCleanTree'));
    await clean.ui.destroy();

    const noRepo = await setup({
      startSimplify: (async () => ({ ok: false, reason: 'no-repo' })) as never,
    });
    await noRepo.submit('/simplify ');
    expect(noRepo.ui.frame()).toContain(t('notice.simplifyNoRepo'));
    await noRepo.ui.destroy();
  });
});
