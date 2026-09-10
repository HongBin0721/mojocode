import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type AgentEvent } from '../src/core/events.js';
import { HookRegistry } from '../src/core/hooks.js';
import type { ExtensionAPI, ExtensionCommand, ExtensionStatusEntry } from '../src/core/extension.js';
import { fakeExtensionApi } from './support/extension-api.js';
import type { SessionCustomRecord } from '../src/session/store.js';
import { t } from '../src/i18n/index.js';
import { glyphs } from '../src/ui/theme.js';

const { mockStreamText, mockGenerateText, mockCompactMessages, mockShouldCompact, mockEstimateTokens } =
  vi.hoisted(() => ({
    mockStreamText: vi.fn(),
    mockGenerateText: vi.fn(),
    mockCompactMessages: vi.fn(),
    mockShouldCompact: vi.fn(),
    mockEstimateTokens: vi.fn(),
  }));

vi.mock('ai', () => ({
  streamText: mockStreamText,
  generateText: mockGenerateText,
  stepCountIs: (n: number) => ({ stepCountIs: n }),
}));

vi.mock('../src/agent/compact.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/compact.js')>()),
  compactMessages: mockCompactMessages,
  shouldCompact: mockShouldCompact,
  estimateTokens: mockEstimateTokens,
}));

import { Agent } from '../src/agent/loop.js';
import { goalExtension, GOAL_ENTRY } from '../src/extensions/goal/index.js';

/**
 * `/goal` 扩展:什么时候续跑、什么时候必须停手。跑的是**真实的 Agent 链条**
 * (mock 掉 streamText),而不是一个假 agent——这组测试同时是钩子层的验收:
 * turn_end + followUp 能不能撑起"评估后续跑",agent_end 能不能报出两轮之间
 * 的中断。这里的每一条都是"不停会怎样"的反面:对着被中断的会话续跑、对着
 * 报错的端点续跑、对着读不懂的判词续跑,都是在无人看管的情况下烧钱。
 */

/** 每次 streamText 调用的消息文本快照。 */
const calls: string[][] = [];
let onStream: ((call: number) => void | Promise<void>) | undefined;

function installStream() {
  mockStreamText.mockImplementation((opts: { messages: Array<{ content: unknown }> }) => {
    calls.push(opts.messages.map((m) => String(m.content)));
    const n = calls.length;
    return {
      fullStream: (async function* () {
        await onStream?.(n);
        yield { type: 'finish', totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, finishReason: 'stop' };
      })(),
      responseMessages: Promise.resolve([{ role: 'assistant', content: `回复${n}` }]),
      finishReason: Promise.resolve('stop'),
    };
  });
}

const verdicts = (...replies: string[]) => {
  mockGenerateText.mockReset();
  for (const text of replies) {
    mockGenerateText.mockResolvedValueOnce({ text, usage: { totalTokens: 5 } });
  }
  // 多出来的调用一律判未达成,免得测试意外撞上 mock 耗尽返回 undefined。
  mockGenerateText.mockResolvedValue({ text: 'VERDICT: NOT_MET\nREASON: 继续', usage: { totalTokens: 5 } });
};

/** 真实 Agent + HookRegistry + 一个内存实现的 ExtensionAPI。 */
function makeHost(configOverrides: Record<string, unknown> = {}) {
  const bus = new EventBus();
  const hooks = new HookRegistry();
  const events: AgentEvent[] = [];
  const notices: string[] = [];
  bus.on((e) => {
    events.push(e);
    if (e.type === 'notice') notices.push(e.message);
  });
  const config = {
    maxSteps: 24,
    temperature: 0,
    compactThreshold: 0.8,
    providers: { test: { vision: true } },
    goalMaxTurns: 10,
    ...configOverrides,
  };
  const agent = new Agent({
    model: {} as never,
    provider: {
      id: 'test',
      label: 'Test',
      model: 'test-model',
      baseURL: 'http://localhost',
      contextWindow: 100_000,
      parallelToolCalls: true,
      reasoningEffort: 'auto',
    } as never,
    config: config as never,
    systemPrompt: 'sys',
    tools: {},
    bus,
    hooks,
  });

  const commands = new Map<string, ExtensionCommand>();
  let status: ExtensionStatusEntry | undefined;
  const entries: SessionCustomRecord[] = [];
  const api: ExtensionAPI = fakeExtensionApi({
    id: 'goal',
    on: (name, handler) => hooks.on(name, handler),
    onEvent: (handler) => bus.on(handler),
    registerCommand: (name, command) => {
      commands.set(name, command);
    },
    setStatus: (text, opts) => {
      status = text === undefined ? undefined : { id: 'goal', text, ...(opts?.since !== undefined ? { since: opts.since } : {}) };
    },
    notify: (level, message) => bus.emit({ type: 'notice', level, message }),
    run: (text, opts) => agent.run(text, opts),
    followUp: (text, opts) => agent.followUp(text, opts),
    isRunning: () => agent.isRunning,
    abort: () => agent.abort(),
    history: () => agent.history,
    appendEntry: async (type, data) => {
      entries.push({ type, data, at: new Date().toISOString() });
    },
    entries: (type) => entries.filter((e) => e.type === type),
    config: config as never,
    model: () => ({}) as never,
  });
  goalExtension.setup(api);

  const goal = (args: string) => commands.get('goal')!.handler(args);
  /** 等下一个链条收尾(followUp 空闲开跑是 fire-and-forget,只能这样等)。 */
  const runEnd = () =>
    new Promise<void>((resolve) => {
      const off = bus.on((e) => {
        if (e.type === 'run-end') {
          off();
          resolve();
        }
      });
    });
  const types = () => events.map((e) => e.type);
  return { agent, bus, hooks, config, notices, entries, goal, runEnd, types, status: () => status };
}

beforeEach(() => {
  mockStreamText.mockReset();
  mockGenerateText.mockReset();
  mockCompactMessages.mockReset();
  mockShouldCompact.mockReset().mockReturnValue(false);
  mockEstimateTokens.mockReset().mockReturnValue(0);
  calls.length = 0;
  onStream = undefined;
  installStream();
});

describe('目标循环', () => {
  it('一直续跑到评估器判定达成:每一轮都是完整的新一轮,统计与记录随之落定', async () => {
    verdicts('VERDICT: NOT_MET\nREASON: 还有两个用例在红', 'VERDICT: MET\nREASON: 全绿了');
    const host = makeHost();
    const done = host.runEnd();
    await host.goal('让 npm test 全绿');
    await done;

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['让 npm test 全绿']);
    // 第二轮的指令是评估理由:既是给用户看的解释,也是给模型的指示。
    expect(calls[1]![2]).toContain('The goal is not met yet: 还有两个用例在红');
    expect(host.types().filter((x) => x === 'turn-start')).toHaveLength(2);
    expect(host.types().filter((x) => x === 'run-end')).toHaveLength(1);
    expect(host.notices).toEqual([
      t('notice.goalSet', { condition: '让 npm test 全绿', max: 10 }),
      t('notice.goalNotMet', { reason: '还有两个用例在红', turn: 1, max: 10 }),
      expect.stringContaining(t('notice.goalStopMet', { turns: 2, elapsed: '', tokens: '', detail: '全绿了' }).split('·')[0]!.trim()),
    ]);
    expect(host.status()).toBeUndefined();
    // 记录:设定时写条件,解除时写 null。
    expect(host.entries.map((e) => e.data)).toEqual([{ condition: '让 npm test 全绿' }, null]);
    expect(host.agent.isRunning).toBe(false);
  });

  it('状态行:设定后显示轮数,评估期间标注评估中,解除后清空', async () => {
    let seenDuringEvaluation: ExtensionStatusEntry | undefined;
    mockGenerateText.mockImplementation(async () => {
      seenDuringEvaluation = host.status();
      return { text: 'VERDICT: MET\nREASON: ok', usage: { totalTokens: 1 } };
    });
    const host = makeHost();
    const done = host.runEnd();
    await host.goal('x');
    const afterSet = host.status();
    expect(afterSet?.text).toBe(`${glyphs.goal} ${t('goal.progress', { turn: 0, max: 10 })}`);
    expect(typeof afterSet?.since).toBe('number');
    await done;
    expect(seenDuringEvaluation?.text).toBe(
      `${glyphs.goal} ${t('goal.progress', { turn: 1, max: 10 })} · ${t('goal.evaluating')}`,
    );
    expect(host.status()).toBeUndefined();
  });

  it('触到轮数上限就停,不会无限续跑', async () => {
    verdicts();
    const host = makeHost({ goalMaxTurns: 2 });
    const done = host.runEnd();
    await host.goal('永远达不成');
    await done;
    expect(calls).toHaveLength(2);
    expect(host.notices.at(-1)).toContain(t('notice.goalStopMaxTurns', { turns: 2, detail: '继续' }).slice(0, 12));
    expect(host.entries.at(-1)?.data).toBeNull();
  });

  it('这一轮被 esc 掐了就停手,不评估', async () => {
    verdicts();
    const host = makeHost();
    onStream = () => {
      host.agent.abort();
      throw new Error('The operation was aborted');
    };
    const done = host.runEnd();
    await host.goal('x');
    await done;
    expect(calls).toHaveLength(1);
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(host.notices.at(-1)).toBe(t('notice.goalStopAborted'));
    expect(host.status()).toBeUndefined();
  });

  it('这一轮以错误收尾也停手', async () => {
    verdicts();
    const host = makeHost();
    onStream = () => {
      throw new Error('provider down');
    };
    const done = host.runEnd();
    await host.goal('x');
    await done;
    expect(calls).toHaveLength(1);
    expect(host.notices.at(-1)).toBe(t('notice.goalStopError'));
  });

  it('连续两次判不出判词就停手;判不出一次只是多跑一轮', async () => {
    verdicts('???', '???');
    const host = makeHost();
    const done = host.runEnd();
    await host.goal('x');
    await done;
    expect(calls).toHaveLength(2);
    // 第二轮拿到的是缺省理由,不是空串。
    expect(calls[1]![2]).toContain('The evaluator could not tell yet');
    expect(host.notices.at(-1)).toBe(t('notice.goalStopCheckFailed'));
  });

  it('评估期间 /goal clear:循环立刻退出,晚到的判词作废、不再开下一轮', async () => {
    let resolveVerdict!: (v: { text: string; usage: { totalTokens: number } }) => void;
    mockGenerateText.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveVerdict = resolve;
        }),
    );
    const host = makeHost();
    const done = host.runEnd();
    await host.goal('x');
    await vi.waitFor(() => expect(mockGenerateText).toHaveBeenCalledTimes(1));
    expect(host.agent.isRunning).toBe(true); // 评估窗口里链条仍在跑

    await host.goal('clear');
    expect(host.notices.at(-1)).toBe(t('notice.goalStopCleared'));
    resolveVerdict({ text: 'VERDICT: NOT_MET\nREASON: 继续', usage: { totalTokens: 1 } });
    await done;
    expect(calls).toHaveLength(1);
    expect(host.agent.isRunning).toBe(false);
  });

  it('两轮之间按 esc:排好的续跑被丢弃,目标以 aborted 解除', async () => {
    verdicts('VERDICT: NOT_MET\nREASON: 还没');
    const host = makeHost();
    // 注册在 goal 之后的 turn_end:goal 已经 followUp 了,这时用户按下 esc。
    let pressed = false;
    host.hooks.on('turn_end', () => {
      if (pressed) return;
      pressed = true;
      host.agent.abort();
    });
    const done = host.runEnd();
    await host.goal('x');
    await done;
    expect(calls).toHaveLength(1);
    expect(host.types()).toContain('aborted');
    expect(host.notices.at(-1)).toBe(t('notice.goalStopAborted'));
    expect(host.status()).toBeUndefined();
  });


  it('子 agent 的轮不算数:subagent 的 turn_end 不触发评估', async () => {
    verdicts();
    const host = makeHost();
    await host.goal('x');
    await host.runEnd();
    const before = mockGenerateText.mock.calls.length;
    await host.hooks.turnEnd({ outcome: 'completed', finishReason: 'stop', subagent: true });
    expect(mockGenerateText.mock.calls.length).toBe(before);
  });
});

describe('恢复与会话切换', () => {
  it('从会话记录恢复:不自动开跑,状态行提示待续;第一次开跑才重置统计并开始监管', async () => {
    verdicts('VERDICT: MET\nREASON: ok');
    const host = makeHost();
    host.entries.push({ type: GOAL_ENTRY, data: { condition: '让测试全绿' }, at: 'x' });
    await host.hooks.sessionStart({ reason: 'resume' });
    expect(host.notices.at(-1)).toBe(t('notice.goalRestored', { condition: '让测试全绿' }));
    expect(host.status()).toEqual({ id: 'goal', text: `${glyphs.goal} ${t('goal.pending')}` });
    expect(calls).toHaveLength(0);
    // 裸 /goal 说"尚未开始"。
    await host.goal('');
    expect(host.notices.at(-1)).toBe(t('notice.goalStatusIdle', { condition: '让测试全绿' }));

    await host.agent.run('接着做');
    expect(calls).toHaveLength(1);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    expect(host.notices.at(-1)).toContain('1'); // met in 1 turn
  });

  it('记录最后一条是 null(已解除)则不恢复', async () => {
    const host = makeHost();
    host.entries.push({ type: GOAL_ENTRY, data: { condition: 'a' }, at: 'x' });
    host.entries.push({ type: GOAL_ENTRY, data: null, at: 'y' });
    await host.hooks.sessionStart({ reason: 'resume' });
    expect(host.status()).toBeUndefined();
    expect(host.notices).toEqual([]);
  });

  it('换到没有目标的会话(/new)时旧目标解除,且不往新会话写记录', async () => {
    // 让评估挂起,目标停在评估窗口里(还没被任何结局解除)。
    let resolveVerdict!: (v: { text: string; usage: { totalTokens: number } }) => void;
    mockGenerateText.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveVerdict = resolve;
        }),
    );
    const host = makeHost();
    const done = host.runEnd();
    await host.goal('x');
    await vi.waitFor(() => expect(mockGenerateText).toHaveBeenCalledTimes(1));
    expect(host.entries.map((e) => e.data)).toEqual([{ condition: 'x' }]);

    host.entries.length = 0; // 模拟换成新会话的记录
    await host.hooks.sessionStart({ reason: 'new' });
    expect(host.notices.at(-1)).toBe(t('notice.goalStopCleared'));
    expect(host.entries).toEqual([]);
    resolveVerdict({ text: 'VERDICT: NOT_MET\nREASON: 晚到', usage: { totalTokens: 1 } });
    await done;
    expect(calls).toHaveLength(1); // 晚到的判词作废,没有续跑
  });

  it('恢复目标时原目标也有交代(replaced)', async () => {
    const host = makeHost();
    host.entries.push({ type: GOAL_ENTRY, data: { condition: 'A' }, at: 'x' });
    await host.hooks.sessionStart({ reason: 'startup' });
    host.entries.length = 0;
    host.entries.push({ type: GOAL_ENTRY, data: { condition: 'B' }, at: 'y' });
    await host.hooks.sessionStart({ reason: 'resume' });
    expect(host.notices).toEqual([
      t('notice.goalRestored', { condition: 'A' }),
      t('notice.goalStopReplaced'),
      t('notice.goalRestored', { condition: 'B' }),
    ]);
  });
});

describe('/goal 命令', () => {
  it('裸 /goal 无目标时只说没设过;取消词大小写不敏感,无目标时只提示', async () => {
    const host = makeHost();
    await host.goal('');
    expect(host.notices).toEqual([t('notice.goalNone')]);
    await host.goal('CLEAR');
    expect(host.notices).toEqual([t('notice.goalNone'), t('notice.goalNone')]);
    expect(calls).toHaveLength(0);
  });

  it('运行中不能设新目标', async () => {
    const host = makeHost();
    let release: (() => void) | undefined;
    onStream = () => new Promise<void>((resolve) => (release = resolve));
    const running = host.agent.run('忙着');
    await host.goal('y');
    expect(host.notices.at(-1)).toBe(t('notice.busyCommand', { name: 'goal' }));
    // 流要过几个 await 才开起来;等它挂在 onStream 上再放行。
    await vi.waitFor(() => expect(release).toBeDefined());
    release!();
    await running;
  });

  it('六个取消词都能取消目标', async () => {
    for (const word of ['clear', 'stop', 'off', 'reset', 'none', 'cancel']) {
      calls.length = 0;
      const host = makeHost();
      await host.goal('x');
      await host.goal(word);
      expect(host.notices.at(-1)).toBe(t('notice.goalStopCleared'));
      expect(host.status()).toBeUndefined();
      await host.runEnd();
    }
  });
});
