import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ModelMessage } from 'ai';

const { mockGenerateText } = vi.hoisted(() => ({ mockGenerateText: vi.fn() }));
vi.mock('ai', () => ({ generateText: mockGenerateText }));

import { GoalController } from '../src/agent/goal.js';
import { EventBus, type AgentEvent } from '../src/core/events.js';
import type { Config } from '../src/config/schema.js';

/**
 * 目标循环本身:什么时候续跑、什么时候必须停手。
 *
 * 这里的每一条都是"不停会怎样"的反面:对着被中断的会话续跑、对着报错的
 * 端点续跑、对着读不懂的判词续跑,都是在无人看管的情况下烧钱。
 */

const usage = (total: number) => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cumulativeTotalTokens: total,
  contextWindow: 100_000,
});

/**
 * 假 agent。默认每轮都正常收尾(发 turn-end)——GoalController 正是靠有没有
 * 收到 turn-end 判断这一轮跑成没有。
 */
function makeAgent(bus: EventBus, options?: { emitTurnEnd?: boolean; onRun?: () => void }) {
  const calls: string[] = [];
  const runOptions: (Record<string, unknown> | undefined)[] = [];
  let spend = 0;
  return {
    calls,
    runOptions,
    agent: {
      history: [{ role: 'user', content: '开始' }] as ModelMessage[],
      run: async (text: string, opts?: Record<string, unknown>) => {
        calls.push(text);
        runOptions.push(opts);
        options?.onRun?.();
        spend += 100;
        if (options?.emitTurnEnd !== false) {
          bus.emit({ type: 'turn-end', usage: usage(spend), finishReason: 'stop' });
        }
      },
    },
  };
}

function makeController(
  bus: EventBus,
  agent: { history: ModelMessage[]; run: (text: string) => Promise<void> },
  goalMaxTurns = 10,
) {
  return new GoalController({
    agent,
    bus,
    config: { goalMaxTurns } as Config,
    evaluatorModel: () => ({}) as never,
    onChange: () => {},
  });
}

function record(bus: EventBus): AgentEvent[] {
  const events: AgentEvent[] = [];
  bus.on((event) => events.push(event));
  return events;
}

const verdicts = (...replies: string[]) => {
  mockGenerateText.mockReset();
  for (const text of replies) {
    mockGenerateText.mockResolvedValueOnce({ text, usage: { totalTokens: 5 } });
  }
  // 多出来的调用一律判未达成,免得测试意外撞上 mock 耗尽返回 undefined。
  mockGenerateText.mockResolvedValue({
    text: 'VERDICT: NOT_MET\nREASON: 继续',
    usage: { totalTokens: 5 },
  });
};

beforeEach(() => {
  mockGenerateText.mockReset();
});

describe('目标循环', () => {
  it('一直续跑到评估器判定达成', async () => {
    const bus = new EventBus();
    const { agent, calls } = makeAgent(bus);
    const goal = makeController(bus, agent);
    const events = record(bus);
    verdicts('VERDICT: NOT_MET\nREASON: 还差一个用例', 'VERDICT: MET\nREASON: 全绿了');

    goal.set('测试全绿');
    await goal.run('测试全绿');

    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe('测试全绿');
    // 第二轮的指令由评估理由生成,而不是重复原始条件。
    expect(calls[1]).toContain('还差一个用例');
    expect(calls[1]).toContain('测试全绿');

    const stop = events.find((e) => e.type === 'goal-stop');
    expect(stop).toMatchObject({ reason: 'met', turns: 2 });
    expect(goal.active).toBe(false);
    expect(goal.busy).toBe(false);
  });

  it('触到轮数上限就停,不会无限续跑', async () => {
    const bus = new EventBus();
    const { agent, calls } = makeAgent(bus);
    const goal = makeController(bus, agent, 3);
    const events = record(bus);
    verdicts();

    goal.set('永远达不成');
    await goal.run('永远达不成');

    expect(calls).toHaveLength(3);
    expect(events.find((e) => e.type === 'goal-stop')).toMatchObject({
      reason: 'max-turns',
      turns: 3,
    });
  });

  it('这一轮没有 turn-end(被 esc 掐了)就停手', async () => {
    // 中断与致命错误都走不到 loop.ts 的 turn-end,这是"跑成没有"最精确的信号。
    // 听 error 事件不行:一次可恢复的流内错误也会发它。
    const bus = new EventBus();
    const { agent, calls } = makeAgent(bus, {
      emitTurnEnd: false,
      onRun: () => bus.emit({ type: 'aborted' }),
    });
    const goal = makeController(bus, agent);
    const events = record(bus);
    verdicts();

    goal.set('随便什么');
    await goal.run('随便什么');

    expect(calls).toHaveLength(1);
    expect(mockGenerateText).not.toHaveBeenCalled(); // 连评估都不该发生
    expect(events.find((e) => e.type === 'goal-stop')).toMatchObject({ reason: 'aborted' });
  });

  it('这一轮以错误收尾(无 turn-end、无 aborted)也停手', async () => {
    const bus = new EventBus();
    const { agent } = makeAgent(bus, { emitTurnEnd: false });
    const goal = makeController(bus, agent);
    const events = record(bus);
    verdicts();

    goal.set('随便什么');
    await goal.run('随便什么');

    expect(events.find((e) => e.type === 'goal-stop')).toMatchObject({ reason: 'error' });
  });

  it('可恢复的流内错误不影响续跑', async () => {
    // 一次工具调用失败就掐掉整个目标,这功能就没法用了。
    const bus = new EventBus();
    const { agent, calls } = makeAgent(bus, {
      onRun: () => bus.emit({ type: 'error', error: new Error('工具炸了'), recoverable: true }),
    });
    const goal = makeController(bus, agent);
    verdicts('VERDICT: NOT_MET\nREASON: 接着修', 'VERDICT: MET\nREASON: 好了');

    goal.set('修好它');
    await goal.run('修好它');

    expect(calls).toHaveLength(2);
  });

  it('连续两次判不出判词就停手', async () => {
    const bus = new EventBus();
    const { agent, calls } = makeAgent(bus);
    const goal = makeController(bus, agent);
    const events = record(bus);
    mockGenerateText.mockReset();
    mockGenerateText.mockResolvedValue({ text: '呃……说不好', usage: { totalTokens: 5 } });

    goal.set('随便什么');
    await goal.run('随便什么');

    // 第一次判不出仍给一次机会,第二次就收手。
    expect(calls).toHaveLength(2);
    expect(events.find((e) => e.type === 'goal-stop')).toMatchObject({ reason: 'check-failed' });
  });

  it('评估器调用抛异常不会拒绝用户那一轮的 Promise', async () => {
    const bus = new EventBus();
    const { agent } = makeAgent(bus);
    const goal = makeController(bus, agent);
    mockGenerateText.mockReset();
    mockGenerateText.mockRejectedValue(new Error('评估器 429'));

    goal.set('随便什么');
    await expect(goal.run('随便什么')).resolves.toBeUndefined();
  });

  it('评估期间被 clear:循环立刻退出,不再开下一轮', async () => {
    const bus = new EventBus();
    const { agent, calls } = makeAgent(bus);
    const goal = makeController(bus, agent);
    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation(async () => {
      goal.clear('cleared'); // 相当于评估窗口里用户敲了 /goal clear 或 /new
      return { text: 'VERDICT: NOT_MET\nREASON: 继续', usage: { totalTokens: 5 } };
    });

    goal.set('随便什么');
    await goal.run('随便什么');

    expect(calls).toHaveLength(1);
    expect(goal.active).toBe(false);
  });

  it('切进计划模式会就地解除目标', async () => {
    // 计划模式停下来等批准,而 exit_plan 获批会在循环中途改权限——那是一次
    // 无人看管的提权,不能留着暗桩。
    const bus = new EventBus();
    const { agent } = makeAgent(bus);
    const goal = makeController(bus, agent);
    const events = record(bus);

    goal.set('随便什么');
    bus.emit({
      type: 'permission-change',
      permissions: { sandbox: 'read-only', approval: 'untrusted' },
      plan: true,
    });

    expect(goal.active).toBe(false);
    expect(events.find((e) => e.type === 'goal-stop')).toMatchObject({ reason: 'plan-mode' });
  });

  it('steer:评估窗口里的用户消息取代评估器的引导', async () => {
    const bus = new EventBus();
    const { agent, calls } = makeAgent(bus);
    const goal = makeController(bus, agent);
    let steered = false;
    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation(async () => {
      if (!steered) {
        steered = true;
        expect(goal.steer('先去看看 README')).toBe(true);
      }
      return { text: 'VERDICT: NOT_MET\nREASON: 评估器的建议', usage: { totalTokens: 5 } };
    });

    goal.set('随便什么');
    await goal.run('随便什么');

    expect(calls[1]).toBe('先去看看 README');
    expect(calls[1]).not.toContain('评估器的建议');
  });

  it('steer 的 display 一路带到那一轮:时间线不会糊上 @展开的全文', async () => {
    // 这条消息最终是经 agent.run 发出的,会发 turn-start,时间线照
    // `display ?? userText` 回显。丢了 display,整个文件内容就会进时间线。
    const bus = new EventBus();
    const { agent, calls, runOptions } = makeAgent(bus);
    const goal = makeController(bus, agent);
    let steered = false;
    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation(async () => {
      if (!steered) {
        steered = true;
        goal.steer('看 <file>…一大坨…</file>', { display: '看 @a.ts' });
      }
      return { text: 'VERDICT: NOT_MET\nREASON: 继续', usage: { totalTokens: 5 } };
    });

    goal.set('随便什么');
    await goal.run('随便什么');

    expect(calls[1]).toContain('一大坨');
    expect(runOptions[1]).toEqual({ display: '看 @a.ts' });
  });

  it('循环结束时还没消化的 steer 会作为独立一轮发出去', async () => {
    // 吞掉它是本仓库最忌讳的失败模式:UI 已经回显过,历史里却没有。
    const bus = new EventBus();
    const { agent, calls } = makeAgent(bus);
    const goal = makeController(bus, agent);
    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation(async () => {
      goal.steer('别忘了这条');
      return { text: 'VERDICT: MET\nREASON: 达成了', usage: { totalTokens: 5 } };
    });

    goal.set('随便什么');
    await goal.run('随便什么');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toContain('别忘了这条');
  });

  it('没有目标时 run 就是原样透传', async () => {
    const bus = new EventBus();
    const { agent, calls } = makeAgent(bus);
    const goal = makeController(bus, agent);

    await goal.run('普通消息');

    expect(calls).toEqual(['普通消息']);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('恢复来的目标不自动开跑,第一次 run 才开始监管并重置统计', async () => {
    const bus = new EventBus();
    const { agent, calls } = makeAgent(bus);
    const goal = makeController(bus, agent);
    const events = record(bus);

    goal.restore('之前没做完的事');
    expect(goal.active).toBe(true);
    expect(goal.busy).toBe(false);
    expect(goal.snapshot()?.restored).toBe(true);
    expect(calls).toHaveLength(0);
    expect(events.find((e) => e.type === 'goal-start')).toMatchObject({ restored: true });

    verdicts('VERDICT: MET\nREASON: 这回做完了');
    await goal.run('接着干');
    expect(calls).toEqual(['接着干']);
    expect(events.find((e) => e.type === 'goal-stop')).toMatchObject({ turns: 1 });
  });

  it('重设目标时先给原目标发一条 replaced 收尾', async () => {
    const bus = new EventBus();
    const { agent } = makeAgent(bus);
    const goal = makeController(bus, agent);
    const events = record(bus);

    goal.set('第一个');
    goal.set('第二个');

    expect(events.filter((e) => e.type === 'goal-stop')).toMatchObject([{ reason: 'replaced' }]);
    expect(goal.state?.condition).toBe('第二个');
  });

  it('token 统计不会因为历史被清空而算成负数', async () => {
    const bus = new EventBus();
    const { agent } = makeAgent(bus);
    const goal = makeController(bus, agent);
    const events = record(bus);

    bus.emit({ type: 'step-end', usage: usage(9000) });
    goal.set('随便什么'); // 基线 9000
    bus.emit({ type: 'step-end', usage: usage(0) }); // agent.clear() 把累计清零了
    goal.clear();

    const stop = events.find((e) => e.type === 'goal-stop');
    expect(stop && 'tokens' in stop && stop.tokens).toBeGreaterThanOrEqual(0);
  });

  it('累计用量被清零(/resume)后基线跟着回落,花销不会一直显示 0', async () => {
    const bus = new EventBus();
    const { agent } = makeAgent(bus);
    const goal = makeController(bus, agent);
    const events = record(bus);

    bus.emit({ type: 'step-end', usage: usage(80_000) }); // 上一个会话烧掉的
    goal.restore('之前没做完的事'); // 基线此刻是 80000
    bus.emit({ type: 'step-end', usage: usage(500) }); // resume 把 agent 的累计清零了
    bus.emit({ type: 'step-end', usage: usage(1500) });
    goal.clear();

    const stop = events.filter((e) => e.type === 'goal-stop').at(-1);
    expect(stop && 'tokens' in stop && stop.tokens).toBe(1000);
  });

  it('停止目标会掐掉在途的评估请求', async () => {
    // 光靠代数作废的话请求还在飞,supervising 就一直是真——命令被 busy 拦着、
    // esc 又被 goal.busy 这一支吃掉,碰上卡住的端点就只剩 ctrl+c 能救。
    const bus = new EventBus();
    const { agent } = makeAgent(bus);
    const goal = makeController(bus, agent);
    let signal: AbortSignal | undefined;
    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation(async (args: { abortSignal?: AbortSignal }) => {
      signal = args.abortSignal;
      goal.clear('aborted');
      return { text: 'VERDICT: NOT_MET\nREASON: 继续', usage: { totalTokens: 5 } };
    });

    goal.set('随便什么');
    await goal.run('随便什么');

    expect(signal?.aborted).toBe(true);
  });

  it('恢复目标时原目标也有交代', async () => {
    // /resume 从带目标 A 的会话进到带目标 B 的会话:只说"已恢复 B"的话,
    // 用户永远不知道 A 被丢了。
    const bus = new EventBus();
    const { agent } = makeAgent(bus);
    const goal = makeController(bus, agent);
    const events = record(bus);

    goal.set('目标 A');
    goal.restore('目标 B');

    expect(events.filter((e) => e.type === 'goal-stop')).toMatchObject([{ reason: 'replaced' }]);
    expect(goal.state?.condition).toBe('目标 B');
  });

  it('监管中 busy 为真——包括两轮之间的评估窗口', async () => {
    const bus = new EventBus();
    const seen: boolean[] = [];
    const { agent } = makeAgent(bus);
    const goal = makeController(bus, agent);
    mockGenerateText.mockReset();
    mockGenerateText.mockImplementation(async () => {
      // 这一刻 agent 是空闲的,busy 却必须为真:否则 esc 会去武装回退选择器、
      // /clear 会从这个缝里溜进去把会话换掉。
      seen.push(goal.busy);
      return { text: 'VERDICT: MET\nREASON: 好了', usage: { totalTokens: 5 } };
    });

    goal.set('随便什么');
    const running = goal.run('随便什么');
    expect(goal.busy).toBe(true);
    await running;

    expect(seen).toEqual([true]);
    expect(goal.busy).toBe(false);
  });
});
