import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type AgentEvent } from '../src/core/events.js';

const { mockStreamText } = vi.hoisted(() => ({ mockStreamText: vi.fn() }));

vi.mock('ai', () => ({
  streamText: mockStreamText,
  stepCountIs: () => undefined,
  // task.ts 只用 tool() 打包定义;原样返回即可拿到 execute 直接调用。
  tool: (def: unknown) => def,
}));

vi.mock('../src/agent/compact.js', () => ({
  compactMessages: vi.fn(),
  shouldCompact: () => false,
}));

import { createTaskTool, finalAssistantText, type TaskToolDeps } from '../src/tools/task.js';

type StreamPart = Record<string, unknown>;

/** 装一个假流:依次吐出 parts,响应消息为 responseMessages。 */
function installStream(parts: StreamPart[], responseMessages: unknown[]) {
  mockStreamText.mockImplementation(() => ({
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    responseMessages: Promise.resolve(responseMessages),
    finishReason: Promise.resolve('stop'),
  }));
}

const finishStep = (input: number, output: number): StreamPart => ({
  type: 'finish-step',
  usage: { inputTokens: input, outputTokens: output, totalTokens: input + output },
});
const finish: StreamPart = { type: 'finish', totalUsage: {}, finishReason: 'stop' };

function makeDeps(configOverrides: Record<string, unknown> = {}) {
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.on((e) => events.push(e));
  const onTokens = vi.fn();
  const onTranscript = vi.fn();
  const deps: TaskToolDeps = {
    config: { maxSteps: 10, compactThreshold: 0.8, ...configOverrides } as never,
    bus,
    model: () => ({}) as never,
    provider: () =>
      ({
        id: 'test',
        label: 'Test',
        model: 'test-model',
        baseURL: 'http://localhost',
        contextWindow: 100_000,
        parallelToolCalls: true,
        reasoningEffort: 'auto',
      }) as never,
    systemPrompt: vi.fn(() => 'sub system prompt'),
    tools: vi.fn(() => ({})),
    onTokens,
    onTranscript,
  };
  return { deps, events, onTokens, onTranscript };
}

type Execute = (
  input: { description: string; prompt: string; mode?: 'general' | 'explore' },
  options: { toolCallId: string; abortSignal?: AbortSignal },
) => Promise<{ result: string; steps: number; tokens: number; incomplete?: string }>;
const executeOf = (deps: TaskToolDeps): Execute =>
  (createTaskTool(deps) as unknown as { execute: Execute }).execute;

beforeEach(() => {
  mockStreamText.mockReset();
});

describe('task 工具', () => {
  it('返回子 agent 的最终报告与步数/token,用量并入主 agent', async () => {
    installStream(
      [
        { type: 'tool-call', toolCallId: 'c1', toolName: 'grep', input: { pattern: 'x' } },
        { type: 'tool-result', toolCallId: 'c1', toolName: 'grep', output: { count: 1 } },
        finishStep(100, 50),
        finishStep(200, 30),
        finish,
      ],
      [{ role: 'assistant', content: '调研结论:找到了。' }],
    );
    const { deps, events, onTokens } = makeDeps();

    const out = await executeOf(deps)(
      { description: '找调用点', prompt: '搜一下 x 的调用点' },
      { toolCallId: 'task-1' },
    );

    expect(out).toEqual({ result: '调研结论:找到了。', steps: 2, tokens: 380 });
    expect(onTokens).toHaveBeenCalledWith(380);

    // 进度事件带 callId 与递增步数;工具开始时带 currentTool 与轨迹。
    const progress = events.filter((e) => e.type === 'task-progress');
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress[0]).toMatchObject({ callId: 'task-1', description: '找调用点', currentTool: 'grep' });
    expect(progress[0]).toMatchObject({
      recentCalls: [{ toolName: 'grep', input: { pattern: 'x' } }],
    });
    expect(progress.at(-1)).toMatchObject({ steps: 2, tokens: 380 });
    // 子 agent 的细节事件(text/tool/step)不得漏进主总线。
    expect(events.some((e) => e.type === 'tool-start' || e.type === 'step-end')).toBe(false);
  });

  it('过程轨迹只保留最近 3 条工具调用,旧的滚出', async () => {
    const call = (n: number): StreamPart[] => [
      { type: 'tool-call', toolCallId: `c${n}`, toolName: `tool${n}`, input: { n } },
      { type: 'tool-result', toolCallId: `c${n}`, toolName: `tool${n}`, output: {} },
    ];
    installStream(
      [...call(1), ...call(2), ...call(3), ...call(4), finishStep(10, 5), finish],
      [{ role: 'assistant', content: 'ok' }],
    );
    const { deps, events } = makeDeps();
    await executeOf(deps)({ description: 'd', prompt: 'p' }, { toolCallId: 't' });

    const last = events.filter((e) => e.type === 'task-progress').at(-1)!;
    expect(last.type === 'task-progress' && last.recentCalls?.map((c) => c.toolName)).toEqual([
      'tool2',
      'tool3',
      'tool4',
    ]);
  });

  it('把 prompt 原样喂给子 agent,系统提示词来自 deps', async () => {
    installStream([finish], [{ role: 'assistant', content: 'ok' }]);
    const { deps } = makeDeps();
    await executeOf(deps)({ description: 'd', prompt: '完整独立的任务简报' }, { toolCallId: 't' });

    const call = mockStreamText.mock.calls[0]![0] as {
      system: string;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(call.system).toBe('sub system prompt');
    expect(call.messages[0]).toEqual({ role: 'user', content: '完整独立的任务简报' });
  });

  it('子 agent 一个字没产出时抛出失败原因(取最后一条 error 事件)', async () => {
    mockStreamText.mockImplementation(() => ({
      fullStream: (async function* () {
        throw new Error('401 invalid api key');
        yield finish; // eslint 安抚:标记为生成器
      })(),
      responseMessages: Promise.resolve([]),
      finishReason: Promise.resolve('error'),
    }));
    const { deps, onTokens } = makeDeps();

    await expect(
      executeOf(deps)({ description: 'd', prompt: 'p' }, { toolCallId: 't' }),
    ).rejects.toThrow(/subagent failed/);
    // 失败也要把已花掉的钱记上(这里是 0,但回调必须被调)。
    expect(onTokens).toHaveBeenCalledWith(0);
  });

  it('主轮中断时子 agent 跟着停,工具以"被中断"收场', async () => {
    const outer = new AbortController();
    mockStreamText.mockImplementation((opts: { abortSignal: AbortSignal }) => ({
      fullStream: (async function* () {
        yield finishStep(10, 5);
        // 模拟 esc:主轮的信号中断 → task 的监听器调 agent.abort()。
        outer.abort();
        // 内层信号此时应已联动中断;SDK 在真实场景会以 AbortError 收流。
        expect(opts.abortSignal.aborted).toBe(true);
        throw new Error('aborted');
      })(),
      responseMessages: Promise.resolve([]),
      finishReason: Promise.resolve('stop'),
    }));
    const { deps, onTokens } = makeDeps();

    await expect(
      executeOf(deps)({ description: 'd', prompt: 'p' }, { toolCallId: 't', abortSignal: outer.signal }),
    ).rejects.toThrow(/interrupted/);
    // 中断前已消耗的部分照记。
    expect(onTokens).toHaveBeenCalledWith(15);
  });

  it('信号已中断时直接拒绝,不起流', async () => {
    const outer = new AbortController();
    outer.abort();
    const { deps } = makeDeps();
    await expect(
      executeOf(deps)({ description: 'd', prompt: 'p' }, { toolCallId: 't', abortSignal: outer.signal }),
    ).rejects.toThrow(/interrupted/);
    expect(mockStreamText).not.toHaveBeenCalled();
  });
});

describe('报告的可信度标注', () => {
  // 撞上 maxSteps 时末条 assistant 只有工具调用,往回找到的是开头那句
  // "我先 grep 一下"——把它当结论交给主 agent 是最坏的一种错。
  it('步数耗尽(finishReason=tool-calls)时标记不完整', async () => {
    mockStreamText.mockImplementation(() => ({
      fullStream: (async function* () {
        yield finishStep(10, 5);
        yield { type: 'finish', totalUsage: {}, finishReason: 'tool-calls' };
      })(),
      responseMessages: Promise.resolve([
        { role: 'assistant', content: '我先 grep 一下调用点。' },
        { role: 'tool', content: [] },
      ]),
      finishReason: Promise.resolve('tool-calls'),
    }));
    const { deps } = makeDeps();
    const out = await executeOf(deps)({ description: 'd', prompt: 'p' }, { toolCallId: 't' });
    expect(out.incomplete).toMatch(/step budget/);
    expect(out.result).toBe('我先 grep 一下调用点。');
  });

  // 流级异常走 streamText 的 onError 回调,不在 fullStream 里(loop.ts 的
  // fullStream switch 根本没有 'error' 分支)——假流必须照这条路径触发。
  it('中途出错但有部分文本时照样标记不完整', async () => {
    mockStreamText.mockImplementation((opts: { onError: (e: { error: unknown }) => void }) => ({
      fullStream: (async function* () {
        yield finishStep(10, 5);
        opts.onError({ error: new Error('429 rate limit') });
        yield finish;
      })(),
      responseMessages: Promise.resolve([{ role: 'assistant', content: '只查了一半。' }]),
      finishReason: Promise.resolve('stop'),
    }));
    const { deps } = makeDeps();
    const out = await executeOf(deps)({ description: 'd', prompt: 'p' }, { toolCallId: 't' });
    expect(out.incomplete).toMatch(/429/);
  });

  it('正常收工不带 incomplete 字段', async () => {
    installStream([finishStep(10, 5), finish], [{ role: 'assistant', content: '完整结论' }]);
    const { deps } = makeDeps();
    const out = await executeOf(deps)({ description: 'd', prompt: 'p' }, { toolCallId: 't' });
    expect('incomplete' in out).toBe(false);
  });

  it('报告与其他工具结果一样封顶,不把无上限的正文灌回主上下文', async () => {
    const huge = 'x'.repeat(60_000);
    installStream([finish], [{ role: 'assistant', content: huge }]);
    const { deps } = makeDeps();
    const out = await executeOf(deps)({ description: 'd', prompt: 'p' }, { toolCallId: 't' });
    expect(out.result.length).toBeLessThan(31_000);
    expect(out.result).toContain('truncated');
  });
});

describe('finalAssistantText', () => {
  it('取最后一条带非空文本的 assistant,跳过末尾工具消息与纯工具调用', () => {
    expect(
      finalAssistantText([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'text', text: '第一段' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '最终报告' },
            { type: 'tool-call', toolCallId: 'c', toolName: 'read', input: {} } as never,
          ],
        },
        { role: 'tool', content: [] as never },
      ]),
    ).toBe('最终报告');
    expect(finalAssistantText([{ role: 'user', content: 'q' }])).toBeUndefined();
    expect(
      finalAssistantText([{ role: 'assistant', content: [{ type: 'text', text: '  ' }] }]),
    ).toBeUndefined();
  });
});

describe('子 agent 的 readFiles 与主 agent 隔离', () => {
  // 护栏要保证的是"改的那个 agent 亲眼看过内容"。共享 readFiles 会让主 agent
  // 凭子 agent 的阅读就能 edit 一个自己从没读过的文件。
  it('子工具集用独立的 readFiles,主 agent 读过的不算子 agent 读过', async () => {
    const { createFileTools } = await import('../src/tools/files.js');
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-subctx-'));
    await fs.writeFile(path.join(root, 'a.ts'), 'hello world\n');

    const base = {
      root,
      gate: { assertCanMutate: () => {}, checkWrite: async () => {} },
      rules: { denyPath: [] },
      readFiles: new Set<string>(),
    };
    // bootstrap 里 subagentTools() 的做法:同一个 context 展开,换一个新的 Set。
    const subContext = { ...base, readFiles: new Set<string>(), subagent: true };

    type Exec = (i: Record<string, unknown>, o: unknown) => Promise<Record<string, unknown>>;
    const execOf = (tl: unknown) => (tl as { execute: Exec }).execute;

    // 子 agent 读了文件。
    await execOf(createFileTools(subContext as never).read)({ path: 'a.ts' }, {});
    expect(subContext.readFiles.size).toBe(1);
    // 主 agent 的集合不受影响,edit 仍然拒绝。
    expect(base.readFiles.size).toBe(0);
    await expect(
      execOf(createFileTools(base as never).edit)(
        { path: 'a.ts', oldString: 'hello', newString: 'bye', replaceAll: false },
        {},
      ),
    ).rejects.toThrow(/have not read/);

    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('taskMaxSteps / explore / 过程落盘 / 并行', () => {
  it('taskMaxSteps 独立于主 agent 的 maxSteps,截停文案报的是它', async () => {
    mockStreamText.mockImplementation(() => ({
      fullStream: (async function* () {
        yield finishStep(10, 5);
        yield { type: 'finish', totalUsage: {}, finishReason: 'tool-calls' };
      })(),
      responseMessages: Promise.resolve([{ role: 'assistant', content: '刚开了个头' }]),
      finishReason: Promise.resolve('tool-calls'),
    }));
    const { deps } = makeDeps({ taskMaxSteps: 3 });
    const out = await executeOf(deps)({ description: 'd', prompt: 'p' }, { toolCallId: 't' });
    expect(out.incomplete).toContain('(3 steps)');
  });

  it('mode 透传给工具集与系统提示词', async () => {
    installStream([finish], [{ role: 'assistant', content: 'ok' }]);
    const { deps } = makeDeps();
    await executeOf(deps)(
      { description: 'd', prompt: 'p', mode: 'explore' },
      { toolCallId: 't' },
    );
    expect(deps.tools).toHaveBeenCalledWith('explore');
    expect(deps.systemPrompt).toHaveBeenCalledWith('explore');
  });

  it('过程上报:带完整消息历史与统计', async () => {
    installStream([finishStep(10, 5), finish], [{ role: 'assistant', content: '结论' }]);
    const { deps, onTranscript } = makeDeps();
    await executeOf(deps)(
      { description: '调研', prompt: '查一下', mode: 'general' },
      { toolCallId: 'tr-1' },
    );
    expect(onTranscript).toHaveBeenCalledOnce();
    const transcript = onTranscript.mock.calls[0]![0] as {
      callId: string;
      messages: Array<{ role: string }>;
    };
    expect(transcript).toMatchObject({
      callId: 'tr-1',
      description: '调研',
      mode: 'general',
      steps: 1,
      tokens: 15,
      finishReason: 'stop',
    });
    expect(transcript.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('两个 task 并发:结果、进度、记账都按 callId 各归各', async () => {
    let call = 0;
    mockStreamText.mockImplementation(() => {
      call += 1;
      const n = call;
      return {
        fullStream: (async function* () {
          yield { type: 'tool-call', toolCallId: `c${n}`, toolName: `tool${n}`, input: {} };
          yield { type: 'tool-result', toolCallId: `c${n}`, toolName: `tool${n}`, output: {} };
          yield finishStep(n * 100, 0);
          yield finish;
        })(),
        responseMessages: Promise.resolve([{ role: 'assistant', content: `报告${n}` }]),
        finishReason: Promise.resolve('stop'),
      };
    });
    const { deps, events, onTokens } = makeDeps();
    const exec = executeOf(deps);
    const [a, b] = await Promise.all([
      exec({ description: 'A', prompt: 'a' }, { toolCallId: 'task-A' }),
      exec({ description: 'B', prompt: 'b' }, { toolCallId: 'task-B' }),
    ]);
    // 结果不串台(两个流的先后由实现决定,按内容配对断言)。
    expect([a.result, b.result].sort()).toEqual(['报告1', '报告2']);
    expect([a.tokens, b.tokens].sort((x, y) => x - y)).toEqual([100, 200]);
    expect(
      onTokens.mock.calls.map((c) => c[0] as number).sort((x, y) => x - y),
    ).toEqual([100, 200]);
    // 每个 callId 的进度事件只描述自己的任务。
    const forA = events.filter((e) => e.type === 'task-progress' && e.callId === 'task-A');
    const forB = events.filter((e) => e.type === 'task-progress' && e.callId === 'task-B');
    expect(forA.length).toBeGreaterThan(0);
    expect(forB.length).toBeGreaterThan(0);
    expect(forA.every((e) => e.type === 'task-progress' && e.description === 'A')).toBe(true);
    expect(forB.every((e) => e.type === 'task-progress' && e.description === 'B')).toBe(true);
  });

  it('一个信号同时停两个并发子任务,过程照样各自落盘', async () => {
    const outer = new AbortController();
    let started = 0;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockStreamText.mockImplementation(() => ({
      fullStream: (async function* () {
        yield finishStep(10, 0);
        started += 1;
        await hold;
        throw new Error('aborted');
      })(),
      responseMessages: Promise.resolve([]),
      finishReason: Promise.resolve('stop'),
    }));
    const { deps, onTranscript } = makeDeps();
    const exec = executeOf(deps);
    const settled = Promise.allSettled([
      exec({ description: 'A', prompt: 'a' }, { toolCallId: 'A', abortSignal: outer.signal }),
      exec({ description: 'B', prompt: 'b' }, { toolCallId: 'B', abortSignal: outer.signal }),
    ]);
    await vi.waitFor(() => expect(started).toBe(2));
    outer.abort();
    release();
    const [ra, rb] = await settled;
    expect(ra.status).toBe('rejected');
    expect(rb.status).toBe('rejected');
    expect((ra as PromiseRejectedResult).reason.message).toMatch(/interrupted/);
    expect((rb as PromiseRejectedResult).reason.message).toMatch(/interrupted/);
    expect(onTranscript).toHaveBeenCalledTimes(2);
  });
});
