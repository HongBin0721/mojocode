import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ModelMessage } from 'ai';

const { mockStreamText } = vi.hoisted(() => ({ mockStreamText: vi.fn() }));

vi.mock('ai', () => ({ streamText: mockStreamText }));

import { compactMessages, estimateTokens } from '../src/agent/compact.js';

/** 模拟 streamText 的返回:按 chunks 逐段吐出 textStream。 */
function streamOf(...chunks: string[]) {
  return {
    textStream: (async function* () {
      yield* chunks;
    })(),
  };
}

beforeEach(() => {
  mockStreamText.mockReset().mockImplementation(() => streamOf('摘要'));
});

/** 一轮长工具循环:开头一条用户消息,之后全是 assistant 调用与 tool 结果。 */
function toolLoop(steps: number): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: 'user', content: '开始干活' }];
  for (let i = 0; i < steps; i++) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'read', input: {} }],
    } as ModelMessage);
    messages.push({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: `c${i}`, toolName: 'read', output: {} }],
    } as ModelMessage);
  }
  return messages;
}

describe('摘要请求剥离图片', () => {
  const filePart = { type: 'file', mediaType: 'image/png', data: 'AAAA', filename: 'shot.png' };

  it('被摘要的历史里 file part 换成占位文本,保留区原样', async () => {
    const messages = toolLoop(20);
    messages[0] = {
      role: 'user',
      content: [{ type: 'text', text: '看这张图' }, filePart],
    } as ModelMessage;
    // 保留区末尾放一条带图消息,确认不被改写。
    messages.push({ role: 'user', content: [filePart] } as ModelMessage);

    const result = await compactMessages(messages, {} as never);
    expect(result.removedMessages).toBeGreaterThan(0);

    const sent = mockStreamText.mock.calls[0]![0].messages as ModelMessage[];
    const first = sent[0]!;
    expect(first.content).toEqual([
      { type: 'text', text: '看这张图' },
      { type: 'text', text: '[image omitted]' },
    ]);
    // 保留的尾部消息未被剥离。
    const kept = result.messages[result.messages.length - 1]!;
    expect(kept.content).toEqual([filePart]);
  });
});

describe('compactMessages 的切分点', () => {
  it('尾部没有用户消息的长工具循环也能压缩(轮内压缩的核心场景)', async () => {
    const result = await compactMessages(toolLoop(20), {} as never);

    expect(result.removedMessages).toBeGreaterThan(0);
    expect(mockStreamText).toHaveBeenCalledTimes(1);
  });

  it('绝不把工具结果和产生它的 assistant 调用拆开', async () => {
    // 遍历多种长度,确保切分点永远不会落在 tool 消息上。
    for (let steps = 4; steps <= 24; steps++) {
      const result = await compactMessages(toolLoop(steps), {} as never);
      if (result.removedMessages === 0) continue;
      // 摘要之后的第一条消息就是切点——它不能是孤立的工具结果。
      expect(result.messages[1]!.role).not.toBe('tool');
    }
  });

  it('保留的消息紧接在摘要之后,不丢内容', async () => {
    const messages = toolLoop(10);
    const result = await compactMessages(messages, {} as never);

    expect(result.messages[0]!.role).toBe('user'); // 摘要以 user 身份注入
    expect(String(result.messages[0]!.content)).toContain('摘要');
    expect(result.messages).toHaveLength(messages.length - result.removedMessages + 1);
    // 保留段与原历史尾部逐条对应。
    expect(result.messages.slice(1)).toEqual(messages.slice(result.removedMessages));
  });

  it('历史太短时原样返回,不调用模型', async () => {
    const short: ModelMessage[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在' },
    ];
    const result = await compactMessages(short, {} as never);

    expect(result).toEqual({ messages: short, removedMessages: 0, summaryChars: 0 });
    expect(mockStreamText).not.toHaveBeenCalled();
  });

  it('尾部全是工具结果时安全放弃,而不是切出孤立结果', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '开始' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'read', input: {} }] },
      ...Array.from({ length: 8 }, (_, i) => ({
        role: 'tool' as const,
        content: [{ type: 'tool-result', toolCallId: `c${i}`, toolName: 'read', output: {} }],
      })),
    ] as ModelMessage[];

    const result = await compactMessages(messages, {} as never);
    expect(result.removedMessages).toBe(0);
    expect(mockStreamText).not.toHaveBeenCalled();
  });
});

describe('流式进度回调', () => {
  it('先以 0 报出「请求已发出」,之后按增量报累计字符数', async () => {
    mockStreamText.mockImplementation(() => streamOf('abc', 'de', 'f'));
    const seen: number[] = [];

    const result = await compactMessages(toolLoop(10), {} as never, undefined, (chars) =>
      seen.push(chars),
    );

    expect(seen).toEqual([0, 3, 5, 6]);
    expect(result.summaryChars).toBe(6);
  });

  it('历史太短提前返回时不调用进度回调', async () => {
    const short: ModelMessage[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在' },
    ];
    const seen: number[] = [];

    await compactMessages(short, {} as never, undefined, (chars) => seen.push(chars));

    expect(seen).toEqual([]);
  });
});

describe('流式错误语义', () => {
  it('streamText 吞掉的错误被收集并重抛,与 generateText 一致', async () => {
    // 模拟 AI SDK 的行为:错误不进 textStream(流直接结束),只回调 onError。
    mockStreamText.mockImplementation(
      ({ onError }: { onError: (payload: { error: unknown }) => void }) => ({
        textStream: (async function* () {
          yield '半截摘';
          onError({ error: new Error('boom') });
        })(),
      }),
    );

    await expect(compactMessages(toolLoop(10), {} as never)).rejects.toThrow('boom');
  });
});

describe('estimateTokens 粗估', () => {
  // 只用来*触发*压缩,不用来判断"不需要压缩":所以只断言量级和方向,
  // 不去追一个精确值——追精确正是 shouldCompact 拒绝本地估算的原因。
  it('CJK 按 1 token,ASCII 按 1/4', () => {
    expect(estimateTokens([{ role: 'user', content: '你好世界' }])).toBe(4);
    expect(estimateTokens([{ role: 'user', content: 'abcdefgh' }])).toBe(2);
  });

  it('空白不计,多条消息累加', () => {
    expect(
      estimateTokens([
        { role: 'user', content: '你 好\n世 界' },
        { role: 'assistant', content: '好 的' },
      ]),
    ).toBe(6);
  });

  it('工具调用/结果这类结构化内容按序列化后的文本算', () => {
    const withTool = estimateTokens(toolLoop(1));
    expect(withTool).toBeGreaterThan(0);
    // 步数翻倍,估算随之增长——长工具循环不会被算成 0。
    expect(estimateTokens(toolLoop(4))).toBeGreaterThan(withTool);
  });

  it('图片按 [image omitted] 计,base64 体积不进估算', () => {
    const blob = 'A'.repeat(100_000);
    const withImage = estimateTokens([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'file', mediaType: 'image/png', data: blob, filename: 'shot.png' },
        ],
      } as never,
    ]);
    expect(withImage).toBeLessThan(100);
  });
});
