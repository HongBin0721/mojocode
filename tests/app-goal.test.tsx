import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import { EventBus } from '../src/core/events.js';
import { t } from '../src/i18n/index.js';
import { plain } from './support/ansi.js';
import type { Session } from '../src/app/bootstrap.js';
import type { GoalStatus } from '../src/agent/goal.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));
const ESC = '\x1b';

/**
 * 覆盖 /goal 的命令分支与事件渲染。目标循环本身在 goal-controller.test.ts
 * 里测,这里只关心 App 有没有把三种参数形式分派对、忙/计划模式拦得对,
 * 以及评估窗口(agent 空闲但 goal.busy)里 esc 停的是循环而不是去开回退选择器。
 */
function setup(options?: {
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

  const view = render(<App session={session} />);
  const submit = async (text: string) => {
    view.stdin.write(text);
    await tick();
    view.stdin.write('\r');
    await tick();
  };
  return { bus, run, set, clear, steer, submit, ...view };
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
    const { submit, set, run, unmount } = setup();
    await tick();

    await submit('/goal 让 npm test 全绿');

    expect(set).toHaveBeenCalledWith('让 npm test 全绿');
    // 第一轮的指令就是条件原文——用户写的就是他的意图本身,不套 display,
    // 这样 /resume 回放与 esc-esc 回退都能忠实还原。
    expect(run).toHaveBeenCalledWith('让 npm test 全绿');
    unmount();
  });

  it('裸 /goal 无目标时只说没设过', async () => {
    const { submit, run, frames, unmount } = setup();
    await tick();

    await submit('/goal');

    expect(run).not.toHaveBeenCalled();
    expect(plain(frames.join('\n'))).toContain(t('notice.goalNone'));
    unmount();
  });

  it('裸 /goal 有目标时报告条件、轮数与最近一次判词', async () => {
    const { submit, frames, unmount } = setup({ status: STATUS });
    await tick();

    await submit('/goal');

    const output = plain(frames.join('\n'));
    expect(output).toContain('让 npm test 全绿');
    expect(output).toContain('3/10');
    expect(output).toContain('还有两个用例在红');
    unmount();
  });

  it('恢复来的目标报告"尚未开始",不显示轮数统计', async () => {
    const { submit, frames, unmount } = setup({
      status: { ...STATUS, turns: 0, restored: true, lastReason: '' },
    });
    await tick();

    await submit('/goal');

    expect(plain(frames.join('\n'))).toContain(
      plain(t('notice.goalStatusIdle', { condition: '让 npm test 全绿' })).split('\n')[0]!,
    );
    unmount();
  });

  it('六个取消词都能取消目标', async () => {
    for (const word of ['clear', 'stop', 'off', 'reset', 'none', 'cancel']) {
      const { submit, clear, unmount } = setup({ status: STATUS });
      await tick();
      await submit(`/goal ${word}`);
      expect(clear, word).toHaveBeenCalledWith('cleared');
      unmount();
    }
  });

  it('取消词大小写不敏感,且无目标时只提示不误调 clear', async () => {
    const { submit, clear, frames, unmount } = setup();
    await tick();

    await submit('/goal STOP');

    expect(clear).not.toHaveBeenCalled();
    expect(plain(frames.join('\n'))).toContain(t('notice.goalNone'));
    unmount();
  });

  it('循环运行中仍能 /goal clear —— 它正是停下循环的手段', async () => {
    const { submit, clear, unmount } = setup({ goalBusy: true, status: STATUS });
    await tick();

    await submit('/goal clear');

    expect(clear).toHaveBeenCalledWith('cleared');
    unmount();
  });

  it('循环运行中不能设新目标(那一支会发起一轮)', async () => {
    const { submit, set, frames, unmount } = setup({ goalBusy: true, status: STATUS });
    await tick();

    await submit('/goal 换个目标');

    expect(set).not.toHaveBeenCalled();
    expect(plain(frames.join('\n'))).toContain(t('notice.busyCommand', { name: 'goal' }));
    unmount();
  });

  it('计划模式下拒绝设定目标', async () => {
    // 计划模式的要义是停下来等批准,与一路跑到目标正相反。
    const { submit, set, run, frames, unmount } = setup({ plan: true });
    await tick();

    await submit('/goal 让 npm test 全绿');

    expect(set).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(plain(frames.join('\n'))).toContain('shift+tab');
    unmount();
  });
});

describe('/goal 的事件渲染', () => {
  it('未达成的评估结果进时间线', async () => {
    const { bus, frames, unmount } = setup();
    await tick();

    bus.emit({ type: 'goal-verdict', met: false, reason: '先把 lint 修了', turn: 2, maxTurns: 10 });
    await tick();

    expect(plain(frames.join('\n'))).toContain('先把 lint 修了');
    unmount();
  });

  it('达成时只出一条收尾提示,不和判词重复', async () => {
    const { bus, frames, unmount } = setup();
    await tick();

    bus.emit({ type: 'goal-verdict', met: true, reason: '构建退出码为 0', turn: 2, maxTurns: 10 });
    await tick();
    const afterVerdict = plain(frames.join('\n'));
    expect(afterVerdict).not.toContain('构建退出码为 0');

    bus.emit({
      type: 'goal-stop',
      reason: 'met',
      condition: '让 npm test 全绿',
      detail: '构建退出码为 0',
      turns: 2,
      elapsedMs: 30_000,
      tokens: 5000,
    });
    await tick();
    expect(plain(frames.join('\n'))).toContain('构建退出码为 0');
    unmount();
  });

  it('触顶停下时提示怎么继续', async () => {
    const { bus, frames, unmount } = setup();
    await tick();

    bus.emit({
      type: 'goal-stop',
      reason: 'max-turns',
      condition: '让 npm test 全绿',
      detail: '还差一个用例',
      turns: 10,
      elapsedMs: 300_000,
      tokens: 90_000,
    });
    await tick();

    const output = plain(frames.join('\n'));
    expect(output).toContain('10');
    expect(output).toContain('/goal');
    unmount();
  });
});

describe('评估窗口里提交消息', () => {
  it('交给 steer 而不是另起一轮,且不在这里回显用户气泡', async () => {
    // 回显交给随后那一轮的 turn-start——这条消息最终是经 agent.run 发出去的,
    // 两边都推就会出现两条一模一样的用户气泡。
    const { submit, steer, run, frames, unmount } = setup({ goalBusy: true });
    await tick();
    const before = frames.length;

    await submit('顺便看看 README');

    expect(steer).toHaveBeenCalledWith('顺便看看 README', {});
    expect(run).not.toHaveBeenCalled();
    const after = plain(frames.slice(before).join('\n'));
    expect(after).toContain(t('notice.goalSteered'));
    unmount();
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
    const { bus, frames, unmount } = setup({ goalBusy: true, goalActive: true });
    await tick();
    turn(bus);
    await tick();
    endTurn(bus);
    await tick();

    // 熄灯的话自动循环会每两轮闪一次"已空闲",看着像卡住了。
    expect(plain(frames.at(-1) ?? '')).toContain(t('status.thinking'));
    unmount();
  });

  it('轮中途目标被解除后,turn-end 必须熄灯', async () => {
    // /goal clear(或 shift+tab 切进计划模式)发生在流式过程中时,goal-stop
    // 因为 agent.isRunning 为真没敢熄灯,而此刻循环仍停在 await 上、busy 还是
    // 真——两处都放过去就再没人熄灯,状态行会一直转到用户开下一轮为止。
    const { bus, frames, unmount } = setup({ goalBusy: true, goalActive: false });
    await tick();
    turn(bus);
    await tick();
    expect(plain(frames.at(-1) ?? '')).toContain(t('status.thinking'));

    endTurn(bus);
    await tick();

    expect(plain(frames.at(-1) ?? '')).not.toContain(t('status.thinking'));
    unmount();
  });
});

describe('评估窗口里的 esc', () => {
  it('agent 空闲但循环在跑时,esc 停的是循环,不是去开回退选择器', async () => {
    const { clear, stdin, frames, unmount } = setup({ goalBusy: true, isRunning: false });
    await tick();

    stdin.write(ESC);
    await tick();
    stdin.write(ESC);
    await tick();

    expect(clear).toHaveBeenCalledWith('aborted');
    expect(plain(frames.join('\n'))).not.toContain(t('rewind.title'));
    unmount();
  });
});
