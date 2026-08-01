import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/events.js';

const { mockStreamText, mockCompactMessages, mockShouldCompact } = vi.hoisted(() => ({
  mockStreamText: vi.fn(),
  mockCompactMessages: vi.fn(),
  mockShouldCompact: vi.fn(),
}));

vi.mock('ai', () => ({
  streamText: mockStreamText,
  stepCountIs: () => undefined,
}));

vi.mock('../src/agent/compact.js', () => ({
  compactMessages: mockCompactMessages,
  shouldCompact: mockShouldCompact,
}));

import { Agent } from '../src/agent/loop.js';

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

function makeAgent() {
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
    expect(sent[1]).toContain('末步后的引导');
    expect(agent.history.map((m) => m.content)).toEqual([
      '你好',
      '回复1',
      '末步后的引导',
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

    const injected = prepared[0]!.messages!.filter((m) => m.content === '中途引导');
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
    expect(agent.history.map((m) => m.content)).toContain('要记住的引导');
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
    expect(sent[1]).toContain('B');
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
});
