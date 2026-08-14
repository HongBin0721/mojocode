import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/events.js';

const { mockStreamText, mockCompactMessages, mockShouldCompact, mockEstimateTokens } =
  vi.hoisted(() => ({
    mockStreamText: vi.fn(),
    mockCompactMessages: vi.fn(),
    mockShouldCompact: vi.fn(),
    mockEstimateTokens: vi.fn(),
  }));

vi.mock('ai', () => ({
  streamText: mockStreamText,
  stepCountIs: () => undefined,
}));

vi.mock('../src/agent/compact.js', () => ({
  compactMessages: mockCompactMessages,
  shouldCompact: mockShouldCompact,
  estimateTokens: mockEstimateTokens,
}));

import { Agent, wrapGuidance } from '../src/agent/loop.js';

/** 每次 streamText 调用时的消息快照(this.messages 是活引用,必须复制)。 */
const sent: string[][] = [];
/** 每个流开始播放时的回调,用于模拟"流进行中"发生的注入/中断。 */
let onStream: ((call: number) => void | Promise<void>) | undefined;

function installDefaultStream() {
  mockStreamText.mockImplementation((opts: { messages: Array<{ content: unknown }> }) => {
    sent.push(opts.messages.map((m) => String(m.content)));
    const call = sent.length;
    return {
      fullStream: (async function* () {
        await onStream?.(call);
        yield { type: 'finish', totalUsage: {}, finishReason: 'stop' };
      })(),
      responseMessages: Promise.resolve([{ role: 'assistant', content: `回复${call}` }]),
      finishReason: Promise.resolve('stop'),
    };
  });
}

function makeAgent(providerOverrides: Record<string, unknown> = {}) {
  const bus = new EventBus();
  const events: string[] = [];
  bus.on((e) => events.push(e.type));
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
      ...providerOverrides,
    } as never,
    config: { maxSteps: 24, temperature: 0, compactThreshold: 0.8 } as never,
    systemPrompt: 'sys',
    tools: {},
    bus,
  });
  return { agent, bus, events };
}

beforeEach(() => {
  mockStreamText.mockReset();
  mockCompactMessages.mockReset();
  mockShouldCompact.mockReset().mockReturnValue(false);
  mockEstimateTokens.mockReset().mockReturnValue(0);
  sent.length = 0;
  onStream = undefined;
});

describe('引导消息注入', () => {
  it('末步之后注入的引导立即续跑,而不是被静默丢弃', async () => {
    installDefaultStream();
    const { agent } = makeAgent();
    // mock 不调用 prepareStep,等价于注入发生在最后一步开始之后。
    onStream = (call) => {
      if (call === 1) expect(agent.inject('末步后的引导')).toBe(true);
    };
    await agent.run('你好');

    expect(sent).toHaveLength(2);
    // 引导以 Claude Code 风格的包装喂给模型:原文 + 说明这是运行中插入的消息。
    expect(sent[1]).toContain(wrapGuidance('末步后的引导'));
    expect(agent.history.map((m) => m.content)).toEqual([
      '你好',
      '回复1',
      wrapGuidance('末步后的引导'),
      '回复2',
    ]);
  });

  it('引导只注入一次,后续步骤不重复追加', async () => {
    const prepared: Array<{ messages?: Array<{ content: unknown }> }> = [];
    let agentRef!: Agent;
    mockStreamText.mockImplementation(
      (opts: { prepareStep: (i: { messages: unknown[] }) => Promise<{ messages?: Array<{ content: unknown }> }> }) => ({
        fullStream: (async function* () {
          agentRef.inject('中途引导');
          const step1 = await opts.prepareStep({ messages: [{ role: 'user', content: '你好' }] });
          prepared.push(step1);
          // SDK 语义:上一步 prepareStep 返回的消息会带入下一步的输入。
          const carried = [...step1.messages!, { role: 'assistant', content: '步1输出' }];
          prepared.push(await opts.prepareStep({ messages: carried }));
          yield { type: 'finish', totalUsage: {}, finishReason: 'stop' };
        })(),
        responseMessages: Promise.resolve([]),
        finishReason: Promise.resolve('stop'),
      }),
    );
    const { agent } = makeAgent();
    agentRef = agent;
    await agent.run('你好');

    const injected = prepared[0]!.messages!.filter((m) => m.content === wrapGuidance('中途引导'));
    expect(injected).toHaveLength(1);
    // 第二步的输入已带着引导,不应再改写消息(返回 {})。
    expect(prepared[1]!.messages).toBeUndefined();
  });

  it('中断时已注入的引导仍并入持久历史', async () => {
    let agentRef!: Agent;
    mockStreamText.mockImplementation(
      (opts: { prepareStep: (i: { messages: unknown[] }) => Promise<unknown> }) => ({
        fullStream: (async function* () {
          agentRef.inject('要记住的引导');
          await opts.prepareStep({ messages: [{ role: 'user', content: '你好' }] });
          agentRef.abort();
          throw new Error('stream torn down');
          yield { type: 'finish', totalUsage: {}, finishReason: 'stop' };
        })(),
        responseMessages: Promise.resolve([]),
        finishReason: Promise.resolve('stop'),
      }),
    );
    const { agent, events } = makeAgent();
    agentRef = agent;
    await agent.run('你好');

    expect(events).toContain('aborted');
    expect(agent.history.map((m) => m.content)).toContain(wrapGuidance('要记住的引导'));
  });
});

describe('图片附件', () => {
  const IMG = { mediaType: 'image/png', data: 'iVBORw0KGgo=', filename: 'shot.png' };

  it('run 带图片时历史里是 parts 数组:文本 + file part', async () => {
    installDefaultStream();
    const { agent } = makeAgent();
    await agent.run('看这张图', { images: [IMG] });

    expect(agent.history[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'file', mediaType: 'image/png', data: 'iVBORw0KGgo=', filename: 'shot.png' },
      ],
    });
  });

  it('不带图片时保持裸字符串 content(零扰动)', async () => {
    installDefaultStream();
    const { agent } = makeAgent();
    await agent.run('普通消息');

    expect(agent.history[0]).toEqual({ role: 'user', content: '普通消息' });
  });

  it('运行中注入带图片的引导:包装文本 + file part 落入历史', async () => {
    installDefaultStream();
    const { agent } = makeAgent();
    onStream = (call) => {
      if (call === 1) expect(agent.inject('中途看图', [IMG])).toBe(true);
    };
    await agent.run('你好');

    const guidance = agent.history.find((m) => Array.isArray(m.content));
    expect(guidance).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: wrapGuidance('中途看图') },
        { type: 'file', mediaType: 'image/png', data: 'iVBORw0KGgo=', filename: 'shot.png' },
      ],
    });
  });

  it('运行中重入 run 带图片 → 转为注入时图片不丢', async () => {
    installDefaultStream();
    const { agent } = makeAgent();
    onStream = (call) => {
      if (call === 1) void agent.run('重入消息', { images: [IMG] });
    };
    await agent.run('你好');

    const guidance = agent.history.find((m) => Array.isArray(m.content));
    expect(Array.isArray(guidance?.content) && guidance.content[1]).toMatchObject({
      type: 'file',
      filename: 'shot.png',
    });
  });

  it('turn-start 事件携带 imageCount,不携带图片字节', async () => {
    installDefaultStream();
    const { agent, bus } = makeAgent();
    const starts: unknown[] = [];
    bus.on((e) => {
      if (e.type === 'turn-start') starts.push(e);
    });
    await agent.run('看图', { images: [IMG] });

    expect(starts[0]).toEqual({ type: 'turn-start', userText: '看图', imageCount: 1 });
    expect(JSON.stringify(starts[0])).not.toContain(IMG.data);
  });
});

describe('并发防护', () => {
  it('运行中再次 run 转为注入,不并发第二个流', async () => {
    installDefaultStream();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    onStream = async (call) => {
      if (call === 1) await gate;
    };
    const { agent, events } = makeAgent();
    const first = agent.run('A');
    // controller 在任何 await 之前就位,并发窗口内 isRunning 必须已为 true。
    expect(agent.isRunning).toBe(true);
    const second = agent.run('B');
    release();
    await Promise.all([first, second]);

    expect(events.filter((e) => e === 'turn-start')).toHaveLength(1);
    expect(sent).toHaveLength(2);
    // 运行中的第二次 run 降级为注入,同样带引导包装。
    expect(sent[1]).toContain(wrapGuidance('B'));
  });

  it('压缩失败不会吞掉用户随后提交的消息', async () => {
    installDefaultStream();
    let rejectCompact!: (err: Error) => void;
    mockCompactMessages.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCompact = reject;
        }),
    );
    const { agent } = makeAgent();
    const compacting = agent.compact().catch(() => undefined); // /compact 的调用方自行呈现错误
    const running = agent.run('压缩失败期间提交的消息');
    rejectCompact(new Error('network blip'));
    await Promise.all([compacting, running]);

    // 修复前:压缩的 rejection 会在 push 用户消息之前抛出,消息只留在时间线上,
    // 既没进历史也没发给模型,用户却以为已经送达。
    expect(agent.history.map((m) => m.content)).toContain('压缩失败期间提交的消息');
    expect(sent.flat()).toContain('压缩失败期间提交的消息');
  });

  it('压缩进行中提交的消息不会被压缩结果覆盖', async () => {
    installDefaultStream();
    let releaseCompact!: (result: unknown) => void;
    mockCompactMessages.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCompact = resolve;
        }),
    );
    const { agent } = makeAgent();
    const compacting = agent.compact(); // /compact
    const running = agent.run('压缩期间的消息'); // 压缩未完成时就提交
    releaseCompact({
      messages: [{ role: 'user', content: '摘要' }],
      removedMessages: 5,
      summaryChars: 2,
    });
    await Promise.all([compacting, running]);

    const contents = agent.history.map((m) => m.content);
    expect(contents[0]).toBe('摘要');
    expect(contents).toContain('压缩期间的消息');
  });

  it('压缩把流式进度以 compaction-progress 事件发到总线', async () => {
    mockCompactMessages.mockImplementation(
      async (
        _messages: unknown,
        _model: unknown,
        _keepRecent: unknown,
        onProgress?: (chars: number) => void,
      ) => {
        onProgress?.(0);
        onProgress?.(120);
        onProgress?.(240);
        return {
          messages: [{ role: 'user', content: '摘要' }],
          removedMessages: 3,
          summaryChars: 240,
        };
      },
    );
    const { agent, bus } = makeAgent();
    const progress: number[] = [];
    const order: string[] = [];
    bus.on((e) => {
      if (e.type === 'compaction-progress') progress.push(e.chars);
      if (e.type === 'compaction-progress' || e.type === 'compaction') order.push(e.type);
    });
    await agent.compact();

    expect(progress).toEqual([0, 120, 240]);
    // 进度在前,收尾事件殿后——渲染层靠 compaction 熄灯/交还状态。
    expect(order[order.length - 1]).toBe('compaction');
  });
});

describe('展示文本分离(/init)', () => {
  it('display 只进 turn-start 事件,模型与历史仍拿完整指令', async () => {
    installDefaultStream();
    const { agent, bus } = makeAgent();
    const starts: Array<{ userText: string; display?: string }> = [];
    bus.on((e) => {
      if (e.type === 'turn-start') starts.push({ userText: e.userText, display: e.display });
    });
    await agent.run('完整的 init 指令', { display: '/init' });

    expect(starts).toEqual([{ userText: '完整的 init 指令', display: '/init' }]);
    expect(agent.history[0]?.content).toBe('完整的 init 指令');
    expect(sent[0]).toContain('完整的 init 指令');
  });

  it('不带 options 的 run 不设 display,回显退回 userText', async () => {
    installDefaultStream();
    const { agent, bus } = makeAgent();
    const starts: Array<{ display?: string }> = [];
    bus.on((e) => {
      if (e.type === 'turn-start') starts.push({ display: e.display });
    });
    await agent.run('普通消息');

    expect(starts[0]?.display).toBeUndefined();
  });
});

describe('providerOptions 组装', () => {
  it('auto 且允许并行工具时不传 providerOptions,保持现状', async () => {
    installDefaultStream();
    const { agent } = makeAgent();
    await agent.run('你好');

    expect(mockStreamText.mock.calls[0]![0]).not.toHaveProperty('providerOptions');
  });

  it('parallel_tool_calls 与思考参数合并进同一个 provider 键,不互相覆盖', async () => {
    installDefaultStream();
    const { agent } = makeAgent({ id: 'glm', parallelToolCalls: false, reasoningEffort: 'off' });
    await agent.run('你好');

    expect(mockStreamText.mock.calls[0]![0].providerOptions).toEqual({
      glm: { parallel_tool_calls: false, thinking: { type: 'disabled' } },
    });
  });

  it('deepseek 的思考参数落在固定的 "deepseek" 键下', async () => {
    installDefaultStream();
    const { agent } = makeAgent({ id: 'deepseek', sdk: 'deepseek', reasoningEffort: 'high' });
    await agent.run('你好');

    expect(mockStreamText.mock.calls[0]![0].providerOptions).toEqual({
      deepseek: { thinking: { type: 'enabled' }, reasoningEffort: 'high' },
    });
  });

  it('运行中修改 provider.reasoningEffort 对下一轮立即生效', async () => {
    installDefaultStream();
    const { agent } = makeAgent({ id: 'kimi', model: 'kimi-k3' });
    await agent.run('第一轮');
    expect(mockStreamText.mock.calls[0]![0]).not.toHaveProperty('providerOptions');

    // /think 的手法:直接改共享的 ResolvedProvider 对象。
    (agent as unknown as { options: { provider: { reasoningEffort: string } } }).options.provider.reasoningEffort =
      'max';
    await agent.run('第二轮');
    expect(mockStreamText.mock.calls[1]![0].providerOptions).toEqual({
      kimi: { reasoningEffort: 'max' },
    });
  });
});

describe('轮末事件', () => {
  it('缓存量从 usage 明细透传到 step-end/turn-end', async () => {
    // AI SDK 把 provider 的缓存命中报在 inputTokenDetails.cacheReadTokens;
    // 多步流上 totalUsage 会把各步累加。这里一步就够:验证字段没被
    // usageSnapshot 的窄类型丢掉。
    mockStreamText.mockImplementation(() => ({
      fullStream: (async function* () {
        yield {
          type: 'finish-step',
          usage: {
            inputTokens: 45_600,
            outputTokens: 800,
            inputTokenDetails: { cacheReadTokens: 12_300 },
          },
        };
        yield {
          type: 'finish',
          totalUsage: {
            inputTokens: 45_600,
            outputTokens: 800,
            inputTokenDetails: { cacheReadTokens: 12_300 },
          },
          finishReason: 'stop',
        };
      })(),
      responseMessages: Promise.resolve([]),
      finishReason: Promise.resolve('stop'),
    }));
    const { agent, bus } = makeAgent();
    const snapshots: Array<{ input?: number; cached?: number }> = [];
    bus.on((e) => {
      if (e.type === 'step-end' || e.type === 'turn-end') {
        snapshots.push({ input: e.usage.inputTokens, cached: e.usage.cachedInputTokens });
      }
    });
    await agent.run('你好');

    expect(snapshots).toEqual([
      { input: 45_600, cached: 12_300 },
      { input: 45_600, cached: 12_300 },
    ]);
  });

  it('provider 不报缓存时 cachedInputTokens 缺省——与实测 0% 区分开', async () => {
    mockStreamText.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: 'finish-step', usage: { inputTokens: 1000, outputTokens: 500 } };
        yield { type: 'finish', totalUsage: {}, finishReason: 'stop' };
      })(),
      responseMessages: Promise.resolve([]),
      finishReason: Promise.resolve('stop'),
    }));
    const { agent, bus } = makeAgent();
    const cached: Array<number | undefined> = [];
    bus.on((e) => {
      if (e.type === 'turn-end') cached.push(e.usage.cachedInputTokens);
    });
    await agent.run('你好');

    expect(cached).toEqual([undefined]);
  });

  it('引导续跑的轮,turn-end 用量是各流之和而非最后一个流', async () => {
    // 两个流各带一段缓存命中;若只取最后一个流,续跑轮的输入与命中
    // 都会被低估(命中率随之失真)。
    let agentRef!: Agent;
    mockStreamText.mockImplementation((opts: { messages: Array<{ content: unknown }> }) => {
      sent.push(opts.messages.map((m) => String(m.content)));
      const call = sent.length;
      return {
        fullStream: (async function* () {
          await onStream?.(call);
          yield {
            type: 'finish',
            totalUsage: {
              inputTokens: 40_000,
              outputTokens: 200,
              inputTokenDetails: { cacheReadTokens: 10_000 },
            },
            finishReason: 'stop',
          };
        })(),
        responseMessages: Promise.resolve([]),
        finishReason: Promise.resolve('stop'),
      };
    });
    const { agent, bus } = makeAgent();
    agentRef = agent;
    onStream = (call) => {
      if (call === 1) agentRef.inject('末步后的引导');
    };
    const turnEnd: Array<{ input?: number; cached?: number }> = [];
    bus.on((e) => {
      if (e.type === 'turn-end') {
        turnEnd.push({ input: e.usage.inputTokens, cached: e.usage.cachedInputTokens });
      }
    });
    await agent.run('你好');

    expect(turnEnd).toEqual([{ input: 80_000, cached: 20_000 }]);
  });

  it('引导续跑不会多发一次 turn-end(状态行不会中途消失)', async () => {
    installDefaultStream();
    const { agent, events } = makeAgent();
    // 末步之后注入引导 → run() 会再起一个流续跑同一轮。
    onStream = (call) => {
      if (call === 1) agent.inject('末步后的引导');
    };
    await agent.run('你好');

    expect(sent).toHaveLength(2); // 确实跑了两个流
    expect(events.filter((e) => e === 'turn-end')).toHaveLength(1);
    // turn-end 必须是整轮的最后一个事件,不能夹在两个流中间。
    expect(events[events.length - 1]).toBe('turn-end');
  });

  it('中断的轮不发 turn-end,由 aborted 收尾', async () => {
    // 真实的中断会让 SDK 直接拆掉流,拿不到 finish。
    let agentRef!: Agent;
    mockStreamText.mockImplementation(() => ({
      fullStream: (async function* () {
        agentRef.abort();
        throw new Error('stream torn down');
        yield { type: 'finish', totalUsage: {}, finishReason: 'stop' };
      })(),
      responseMessages: Promise.resolve([]),
      finishReason: Promise.resolve('stop'),
    }));
    const { agent, events } = makeAgent();
    agentRef = agent;
    await agent.run('你好');

    expect(events).toContain('aborted');
    expect(events.filter((e) => e === 'turn-end')).toHaveLength(0);
  });

  it('一轮只播报一次 aborted,下一轮仍会播报', async () => {
    // 真实 SDK 的中断形态:fullStream 补一个 abort 事件后正常收束,而首步
    // 未完成时收尾 Promise 以 AbortError 拒绝——两条路都会走到。
    let agentRef!: Agent;
    // 中断后收尾 Promise 只会被 await 到第一个,其余的拒绝由 SDK 标记为已处理。
    const rejected = () => {
      const p = Promise.reject(new Error('AbortError'));
      p.catch(() => undefined);
      return p;
    };
    mockStreamText.mockImplementation(() => ({
      fullStream: (async function* () {
        agentRef.abort();
        yield { type: 'abort' };
      })(),
      responseMessages: rejected(),
      finishReason: rejected(),
    }));
    const { agent, events } = makeAgent();
    agentRef = agent;
    await agent.run('你好');

    expect(events.filter((e) => e === 'aborted')).toHaveLength(1);

    await agent.run('再来');
    expect(events.filter((e) => e === 'aborted')).toHaveLength(2);
  });
});

describe('会话清空', () => {
  it('clear() 重置累计用量,新会话不背旧账', async () => {
    mockStreamText.mockImplementation(() => ({
      fullStream: (async function* () {
        yield { type: 'finish-step', usage: { inputTokens: 1000, outputTokens: 500 } };
        yield { type: 'finish', totalUsage: {}, finishReason: 'stop' };
      })(),
      responseMessages: Promise.resolve([]),
      finishReason: Promise.resolve('stop'),
    }));
    const { agent, bus } = makeAgent();
    const totals: number[] = [];
    bus.on((e) => {
      if (e.type === 'step-end') totals.push(e.usage.cumulativeTotalTokens);
    });

    await agent.run('第一轮');
    expect(totals.at(-1)).toBe(1500);

    agent.clear();
    await agent.run('清空之后');
    // 修复前这里会是 3000——footer 与 /cost 把旧会话的用量算进新会话。
    expect(totals.at(-1)).toBe(1500);
  });

  it('压缩期间被清空时,压缩结果不会让旧对话复活', async () => {
    installDefaultStream();
    let releaseCompact!: (result: unknown) => void;
    mockCompactMessages.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCompact = resolve;
        }),
    );
    const { agent } = makeAgent();
    await agent.run('压缩前的对话');

    const compacting = agent.compact();
    agent.clear(); // /clear 在摘要返回之前发生
    releaseCompact({
      messages: [{ role: 'user', content: '旧对话的摘要' }],
      removedMessages: 5,
      summaryChars: 6,
    });
    await compacting;

    // 被丢弃的对话不得写回内存(否则还会被存进那个全新的会话文件)。
    expect(agent.history).toEqual([]);
  });
});

describe('上下文告警', () => {
  it('一轮内最多提示一次,不随步骤数刷屏', async () => {
    // 压缩压不动(removedMessages: 0)时 shouldCompact 会持续为真,
    // 每个步骤边界都会重新判断——这正是刷屏的触发条件。
    mockShouldCompact.mockReturnValue(true);
    mockCompactMessages.mockResolvedValue({
      messages: [{ role: 'user', content: '原样' }],
      removedMessages: 0,
      summaryChars: 0,
    });
    mockStreamText.mockImplementation(
      (opts: { prepareStep: (i: { messages: unknown[] }) => Promise<unknown> }) => ({
        fullStream: (async function* () {
          for (let i = 0; i < 5; i++) {
            await opts.prepareStep({ messages: [{ role: 'user', content: '很长的历史' }] });
          }
          yield { type: 'finish', totalUsage: {}, finishReason: 'stop' };
        })(),
        responseMessages: Promise.resolve([]),
        finishReason: Promise.resolve('stop'),
      }),
    );

    const { agent, bus } = makeAgent();
    const notices: string[] = [];
    bus.on((e) => {
      if (e.type === 'notice') notices.push(e.message);
    });

    await agent.run('第一轮');
    expect(notices).toHaveLength(1);

    // 闩锁按轮重置:下一轮仍然会提示一次。
    await agent.run('第二轮');
    expect(notices).toHaveLength(2);
  });
});

describe('轮内压缩', () => {
  it('轮内压缩后,下一轮开轮强制压缩持久历史', async () => {
    mockShouldCompact
      .mockReturnValueOnce(false) // 轮 1 开轮的 maybeCompact
      .mockReturnValueOnce(true) // 轮 1 prepareStep 的轮内压缩
      .mockReturnValue(false); // 之后 token 数看起来都不超
    mockCompactMessages.mockResolvedValue({
      messages: [{ role: 'user', content: '摘要' }],
      removedMessages: 3,
      summaryChars: 2,
    });
    mockStreamText.mockImplementation(
      (opts: { prepareStep: (i: { messages: unknown[] }) => Promise<unknown> }) => ({
        fullStream: (async function* () {
          await opts.prepareStep({ messages: [{ role: 'user', content: '很长的历史' }] });
          yield { type: 'finish', totalUsage: {}, finishReason: 'stop' };
        })(),
        responseMessages: Promise.resolve([{ role: 'assistant', content: '回复' }]),
        finishReason: Promise.resolve('stop'),
      }),
    );
    const { agent } = makeAgent();
    await agent.run('第一轮');
    expect(mockCompactMessages).toHaveBeenCalledTimes(1); // 轮内兜底

    await agent.run('第二轮');
    // 持久历史从未被轮内压缩瘦身,靠 historyNeedsCompact 标记强制补压。
    expect(mockCompactMessages).toHaveBeenCalledTimes(2);
  });

  // 恢复会话已经不再切回记录里的模型,所以换进来的历史可能本来就装不下当前
  // 窗口。provider 上报数在 setHistory 里必然作废,靠本地粗估补上这一刀。
  it('setHistory 换进一段粗估超阈值的历史:下一轮开轮强制压缩', async () => {
    mockEstimateTokens.mockReturnValue(90_000); // > 100_000 * 0.8
    mockCompactMessages.mockResolvedValue({
      messages: [{ role: 'user', content: '摘要' }],
      removedMessages: 3,
      summaryChars: 2,
    });
    const { agent } = makeAgent();
    agent.setHistory([{ role: 'user', content: '很长的历史' }], { resetSpend: true });

    await agent.run('恢复后的第一轮');
    // shouldCompact 全程返回 false(lastInputTokens 是 undefined),压缩只可能
    // 由 setHistory 置位的标记触发。
    expect(mockShouldCompact).not.toHaveReturnedWith(true);
    expect(mockCompactMessages).toHaveBeenCalledTimes(1);

    // 标记是一次性的:压缩过后不再重复。
    await agent.run('第二轮');
    expect(mockCompactMessages).toHaveBeenCalledTimes(1);
  });

  it('setHistory 换进一段粗估装得下的历史:不触发压缩', async () => {
    mockEstimateTokens.mockReturnValue(1_000);
    const { agent } = makeAgent();
    agent.setHistory([{ role: 'user', content: '短历史' }], { resetSpend: true });

    await agent.run('恢复后的第一轮');
    expect(mockCompactMessages).not.toHaveBeenCalled();
  });
});

describe('轮中途替换系统提示词', () => {
  /** 让 mock 在流播放时驱动一次 prepareStep,并交出它的返回值。 */
  function installPreparingStream(beforePrepare?: (agent: Agent) => void) {
    const prepared: Array<Record<string, unknown>> = [];
    let agentRef!: Agent;
    mockStreamText.mockImplementation(
      (opts: { prepareStep: (i: { messages: unknown[] }) => Promise<Record<string, unknown>> }) => ({
        fullStream: (async function* () {
          beforePrepare?.(agentRef);
          prepared.push(await opts.prepareStep({ messages: [] }));
          yield { type: 'finish', totalUsage: {}, finishReason: 'stop' };
        })(),
        responseMessages: Promise.resolve([{ role: 'assistant', content: '回复' }]),
        finishReason: Promise.resolve('stop'),
      }),
    );
    return {
      prepared,
      bind: (a: Agent) => {
        agentRef = a;
      },
    };
  }

  // streamText 的 system 只在开流时读一次:方案获批后不补这一下,整条流会
  // 一直用计划模式那份提示词跑完,模型明明已经能改文件却还在拒绝动手。
  it('轮中换过提示词时,prepareStep 下发新的 instructions', async () => {
    const { prepared, bind } = installPreparingStream((agent) =>
      agent.updateSystemPrompt('切到 ask 之后的新提示词'),
    );
    const { agent } = makeAgent();
    bind(agent);

    await agent.run('你好');

    expect(prepared[0]).toEqual({ instructions: '切到 ask 之后的新提示词' });
  });

  // 这是每步都要走的最热的一段,不为计划模式一个场景给所有人加开销。
  it('提示词没换过时保持返回 {} 的快路径', async () => {
    const { prepared, bind } = installPreparingStream();
    const { agent } = makeAgent();
    bind(agent);

    await agent.run('你好');

    expect(prepared[0]).toEqual({});
  });
});
