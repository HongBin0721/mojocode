import { describe, expect, it, vi } from 'vitest';
import React from 'react';


import { App } from '../../src/ui/App.js';
import { EventBus } from '../../src/core/events.js';
import { t } from '../../src/i18n/index.js';
import { glyphs, WIDTH_SAFETY } from '../../src/ui/theme.js';
import { GoalLine } from '../../src/ui/GoalLine.js';
import type { Session } from '../../src/app/bootstrap.js';
import type { GoalStatus } from '../../src/agent/goal.js';
import { renderUi } from '../support/otui.js';

/**
 * 覆盖 /goal 的命令分支与事件渲染。目标循环本身在 goal-controller.test.ts
 * 里测,这里只关心 App 有没有把三种参数形式分派对、忙/计划模式拦得对,
 * 以及评估窗口(agent 空闲但 goal.busy)里 esc 停的是循环而不是去开回退选择器。
 */
async function setup(options?: {
  goalBusy?: boolean;
  goalActive?: boolean;
  status?: GoalStatus;
  isRunning?: boolean;
  plan?: boolean;
}) {
  const bus = new EventBus();
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const run = vi.fn(async () => {});
  const set = vi.fn();
  const clear = vi.fn();
  const steer = vi.fn(() => options?.goalBusy ?? false);
  const session = {
    root: '/tmp/project',
    config: {
      sandbox: 'workspace-write',
      approval: 'untrusted',
      plan: options?.plan ?? false,
      statusBar: ['mode'],
      goalMaxTurns: 10,
      permissions: { denyPath: [] },
    },
    provider,
    agent: {
      isRunning: options?.isRunning ?? false,
      isCompacting: false,
      history: [],
      inject: () => false,
      run: async () => {},
      abort: () => {},
      clear: () => {},
      compact: async () => {},
    },
    bus,
    gate: { setAsker: () => {} },
    todos: { get: () => [], subscribe: () => () => {} },
    goal: {
      busy: options?.goalBusy ?? false,
      active: options?.goalActive ?? options?.status !== undefined,
      state: undefined,
      snapshot: () => options?.status,
      steer,
      run,
      set,
      restore: () => {},
      clear,
      dispose: () => {},
    },
    mcpStatuses: [],
    store: { id: 'test-session', messages: [] },
    switch: () => provider,
    setPermissions: () => {},
    setPlan: () => {},
    refreshEnvironment: async () => {},
    dispose: async () => {},
  } as unknown as Session;

  const ui = await renderUi(<App session={session} />, { width: 100, height: 45 });
  const submit = async (text: string) => {
    await ui.type(text);
    await ui.press('return');
    // 命令处理/提交展开是异步的,多让一拍再断言。
    await ui.tick();
  };
  return { bus, run, set, clear, steer, submit, ui };
}

const STATUS: GoalStatus = {
  condition: '让 npm test 全绿',
  turns: 3,
  maxTurns: 10,
  elapsedMs: 65_000,
  tokens: 12_345,
  lastReason: '还有两个用例在红',
  restored: false,
};

describe('/goal 命令', () => {
  it('带条件时设定目标并以条件原文发起一轮', async () => {
    const { submit, set, run, ui } = await setup();

    await submit('/goal 让 npm test 全绿');

    expect(set).toHaveBeenCalledWith('让 npm test 全绿');
    // 第一轮的指令就是条件原文——用户写的就是他的意图本身,不套 display,
    // 这样 /resume 回放与 esc-esc 回退都能忠实还原。
    expect(run).toHaveBeenCalledWith('让 npm test 全绿');
    await ui.destroy();
  });

  it('裸 /goal 无目标时只说没设过', async () => {
    const { submit, run, ui } = await setup();

    await submit('/goal');

    expect(run).not.toHaveBeenCalled();
    expect(ui.frame()).toContain(t('notice.goalNone'));
    await ui.destroy();
  });

  it('裸 /goal 有目标时报告条件、轮数与最近一次判词', async () => {
    const { submit, ui } = await setup({ status: STATUS });

    await submit('/goal');

    const output = ui.frame();
    expect(output).toContain('让 npm test 全绿');
    expect(output).toContain('3/10');
    expect(output).toContain('还有两个用例在红');
    await ui.destroy();
  });

  it('恢复来的目标报告"尚未开始",不显示轮数统计', async () => {
    const { submit, ui } = await setup({
      status: { ...STATUS, turns: 0, restored: true, lastReason: '' },
    });

    await submit('/goal');

    expect(ui.frame()).toContain(
      t('notice.goalStatusIdle', { condition: '让 npm test 全绿' }).split('\n')[0]!,
    );
    await ui.destroy();
  });

  it('六个取消词都能取消目标', async () => {
    for (const word of ['clear', 'stop', 'off', 'reset', 'none', 'cancel']) {
      const { submit, clear, ui } = await setup({ status: STATUS });
      await submit(`/goal ${word}`);
      expect(clear, word).toHaveBeenCalledWith('cleared');
      await ui.destroy();
    }
  });

  it('取消词大小写不敏感,且无目标时只提示不误调 clear', async () => {
    const { submit, clear, ui } = await setup();

    await submit('/goal STOP');

    expect(clear).not.toHaveBeenCalled();
    expect(ui.frame()).toContain(t('notice.goalNone'));
    await ui.destroy();
  });

  it('循环运行中仍能 /goal clear —— 它正是停下循环的手段', async () => {
    const { submit, clear, ui } = await setup({ goalBusy: true, status: STATUS });

    await submit('/goal clear');

    expect(clear).toHaveBeenCalledWith('cleared');
    await ui.destroy();
  });

  it('循环运行中不能设新目标(那一支会发起一轮)', async () => {
    const { submit, set, ui } = await setup({ goalBusy: true, status: STATUS });

    await submit('/goal 换个目标');

    expect(set).not.toHaveBeenCalled();
    expect(ui.frame()).toContain(t('notice.busyCommand', { name: 'goal' }));
    await ui.destroy();
  });

  it('计划模式下拒绝设定目标', async () => {
    // 计划模式的要义是停下来等批准,与一路跑到目标正相反。
    const { submit, set, run, ui } = await setup({ plan: true });

    await submit('/goal 让 npm test 全绿');

    expect(set).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(ui.frame()).toContain('shift+tab');
    await ui.destroy();
  });
});

describe('/goal 的事件渲染', () => {
  it('未达成的评估结果进时间线', async () => {
    const { bus, ui } = await setup();

    bus.emit({ type: 'goal-verdict', met: false, reason: '先把 lint 修了', turn: 2, maxTurns: 10 });
    await ui.tick();

    expect(ui.frame()).toContain('先把 lint 修了');
    await ui.destroy();
  });

  it('达成时只出一条收尾提示,不和判词重复', async () => {
    const { bus, ui } = await setup();

    bus.emit({ type: 'goal-verdict', met: true, reason: '构建退出码为 0', turn: 2, maxTurns: 10 });
    await ui.tick();
    expect(ui.frame()).not.toContain('构建退出码为 0');

    bus.emit({
      type: 'goal-stop',
      reason: 'met',
      condition: '让 npm test 全绿',
      detail: '构建退出码为 0',
      turns: 2,
      elapsedMs: 30_000,
      tokens: 5000,
    });
    await ui.tick();
    expect(ui.frame()).toContain('构建退出码为 0');
    await ui.destroy();
  });

  it('触顶停下时提示怎么继续', async () => {
    const { bus, ui } = await setup();

    bus.emit({
      type: 'goal-stop',
      reason: 'max-turns',
      condition: '让 npm test 全绿',
      detail: '还差一个用例',
      turns: 10,
      elapsedMs: 300_000,
      tokens: 90_000,
    });
    await ui.tick();

    const output = ui.frame();
    expect(output).toContain('10');
    expect(output).toContain('/goal');
    await ui.destroy();
  });
});

describe('输入框上方的目标进度', () => {
  it('有目标时靠右显示轮数与已用时', async () => {
    const { ui } = await setup({ status: { ...STATUS, elapsedMs: 64_000 } });

    const line = ui
      .frame()
      .split('\n')
      .find((l) => l.includes(glyphs.goal));
    expect(line).toBeDefined();
    expect(line).toContain('3/10');
    // 整秒展示,不带小数——formatDuration 的 `64.0s` 挂在这里每秒跳尾数只是噪音。
    expect(line).toContain('1m04s');
    // 靠右:前面有一大段留白。
    expect(line).toMatch(/^\s{10,}/);
    await ui.destroy();
  });

  it('恢复来的目标提示待续,不显示轮数', async () => {
    const { ui } = await setup({
      status: { ...STATUS, turns: 0, restored: true, lastReason: '' },
    });

    const output = ui.frame();
    expect(output).toContain(t('goal.pending'));
    expect(output).not.toContain('0/10');
    await ui.destroy();
  });

  // 直接渲染组件,把终端宽度压到 30 列(renderUi 支持显式宽度)。
  it('窄终端下截断,不折成两行', async () => {
    // 折行的话动态区就比 App 的高度预算多出一行——预算只给这里留了一行。
    // 待续那句英文有 40 多列,是最容易撞上的一条。
    const status = { ...STATUS, turns: 0, restored: true, lastReason: '' };
    const ui = await renderUi(<GoalLine snapshot={() => status} columns={30} />, {
      width: 30,
      height: 4,
    });

    // 视口帧固定高度,空行不算内容行。
    const rows = ui
      .frame()
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(rows).toHaveLength(1);
    // 只量文字本身:那一行是靠右对齐的,左边的留白由布局按终端宽度补,
    // 与截断宽度无关。
    expect(rows[0]!.trim().length).toBeLessThanOrEqual(30 - WIDTH_SAFETY);
    expect(rows[0]).toContain(glyphs.goal);
    await ui.destroy();
  });

  it('没有目标时不占行', async () => {
    const { ui } = await setup();

    expect(ui.frame()).not.toContain(glyphs.goal);
    await ui.destroy();
  });

  it('goal-stop 之后这一行消失', async () => {
    const { bus, ui } = await setup({ status: STATUS });
    expect(ui.frame()).toContain(glyphs.goal);

    bus.emit({
      type: 'goal-stop',
      reason: 'met',
      condition: STATUS.condition,
      detail: '好了',
      turns: 3,
      elapsedMs: 1000,
      tokens: 10,
    });
    await ui.tick();

    expect(ui.frame()).not.toContain(glyphs.goal);
    await ui.destroy();
  });
});

describe('评估窗口里提交消息', () => {
  it('交给 steer 而不是另起一轮,且不在这里回显用户气泡', async () => {
    // 回显交给随后那一轮的 turn-start——这条消息最终是经 agent.run 发出去的,
    // 两边都推就会出现两条一模一样的用户气泡。
    const { submit, steer, run, ui } = await setup({ goalBusy: true });

    await submit('顺便看看 README');

    expect(steer).toHaveBeenCalledWith('顺便看看 README', {});
    expect(run).not.toHaveBeenCalled();
    const frame = ui.frame();
    expect(frame).toContain(t('notice.goalSteered'));
    // 时间线上没有用户气泡(`> 原文`),原文也不再留在输入框里。
    expect(frame).not.toContain('> 顺便看看 README');
    await ui.destroy();
  });
});

describe('状态行的收尾', () => {
  const turn = (bus: EventBus) => {
    bus.emit({ type: 'turn-start', userText: '干活' });
  };
  const endTurn = (bus: EventBus) =>
    bus.emit({
      type: 'turn-end',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cumulativeTotalTokens: 100,
        contextWindow: 100_000,
      },
      finishReason: 'stop',
    });

  it('目标还在时 turn-end 不熄灯,交给随后的评估阶段接手', async () => {
    const { bus, ui } = await setup({ goalBusy: true, goalActive: true });
    turn(bus);
    await ui.tick();
    endTurn(bus);
    await ui.tick();

    // 熄灯的话自动循环会每两轮闪一次"已空闲",看着像卡住了。
    expect(ui.frame()).toContain(t('status.thinking'));
    await ui.destroy();
  });

  it('轮中途目标被解除后,turn-end 必须熄灯', async () => {
    // /goal clear(或 shift+tab 切进计划模式)发生在流式过程中时,goal-stop
    // 因为 agent.isRunning 为真没敢熄灯,而此刻循环仍停在 await 上、busy 还是
    // 真——两处都放过去就再没人熄灯,状态行会一直转到用户开下一轮为止。
    const { bus, ui } = await setup({ goalBusy: true, goalActive: false });
    turn(bus);
    await ui.tick();
    expect(ui.frame()).toContain(t('status.thinking'));

    endTurn(bus);
    await ui.tick();

    expect(ui.frame()).not.toContain(t('status.thinking'));
    await ui.destroy();
  });
});

describe('评估窗口里的 esc', () => {
  it('agent 空闲但循环在跑时,esc 停的是循环,不是去开回退选择器', async () => {
    const { clear, ui } = await setup({ goalBusy: true, isRunning: false });

    await ui.press('escape');
    await ui.press('escape');

    expect(clear).toHaveBeenCalledWith('aborted');
    expect(ui.frame()).not.toContain(t('rewind.title'));
    await ui.destroy();
  });
});
