import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type AgentEvent } from '../src/core/events.js';
import { HookRegistry, type HookFailure } from '../src/core/hooks.js';

const { mockStreamText, mockCompactMessages, mockShouldCompact, mockEstimateTokens } =
  vi.hoisted(() => ({
    mockStreamText: vi.fn(),
    mockCompactMessages: vi.fn(),
    mockShouldCompact: vi.fn(),
    mockEstimateTokens: vi.fn(),
  }));

vi.mock('ai', () => ({
  streamText: mockStreamText,
  stepCountIs: (n: number) => ({ stepCountIs: n }),
  // 中间件只记在模型对象上,测试自己调 transformParams 验证钩子接上了。
  wrapLanguageModel: ({ model, middleware }: { model: object; middleware: unknown }) => ({
    ...model,
    middleware,
  }),
}));

vi.mock('../src/agent/compact.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/compact.js')>()),
  compactMessages: mockCompactMessages,
  shouldCompact: mockShouldCompact,
  estimateTokens: mockEstimateTokens,
}));

import { Agent, unwrapCustomMessage, wrapCustomMessage, wrapGuidance } from '../src/agent/loop.js';

type ToolLike = { execute: (input: unknown, options: { toolCallId: string }) => Promise<unknown> };

/** 每次 streamText 调用的快照:system、交给 SDK 的 tools 对象、消息文本。 */
interface Call {
  system: string;
  tools: Record<string, ToolLike>;
  messages: string[];
  model: unknown;
}
const calls: Call[] = [];
/** 第 n 次流要"模拟模型"调用的工具(mock 像 SDK 一样自己去 execute)。 */
let scripts: Array<
  { toolCalls?: Array<{ name: string; input: unknown }>; text?: string[]; reasoning?: string[] } | undefined
> = [];
/** 每个流开始时的回调,用于在"流进行中"注入/中断/抛错。 */
let onStream: ((call: number) => void | Promise<void>) | undefined;

function installStream() {
  mockStreamText.mockImplementation(
    (opts: {
      system: string;
      tools: Record<string, ToolLike>;
      messages: Array<{ content: unknown }>;
      model: unknown;
      prepareStep?: (o: {
        messages: Array<{ content: unknown }>;
        stepNumber: number;
        steps: unknown[];
      }) => Promise<{ messages?: Array<{ content: unknown }> } | undefined>;
    }) => {
      const entry: Call = {
        system: opts.system,
        tools: opts.tools,
        messages: opts.messages.map((m) => String(m.content)),
        model: opts.model,
      };
      calls.push(entry);
      const n = calls.length;
      const script = scripts[n - 1] ?? {};
      return {
        fullStream: (async function* () {
          // 像真 SDK 一样先过 prepareStep(实测:第一步之前也调用,返回的
          // messages 就是真正发出去的那份)。不模拟的话,只在 prepareStep 里
          // 跑的钩子(context、轮内压缩)在测试里全是隐形的。
          const prepared = await opts.prepareStep?.({
            messages: opts.messages,
            stepNumber: 0,
            steps: [],
          });
          if (prepared?.messages) entry.messages = prepared.messages.map((m) => String(m.content));
          // 有文本 / 思考脚本时像真 SDK 一样先发 start-step,再逐段 delta。
          if (script.text || script.reasoning) {
            yield { type: 'start-step' };
            if (script.reasoning) {
              yield { type: 'reasoning-start', id: 'r1' };
              for (const chunk of script.reasoning) yield { type: 'reasoning-delta', id: 'r1', text: chunk };
              yield { type: 'reasoning-end', id: 'r1' };
            }
            if (script.text) {
              yield { type: 'text-start', id: 't1' };
              for (const chunk of script.text) yield { type: 'text-delta', id: 't1', text: chunk };
              yield { type: 'text-end', id: 't1' };
            }
          }
          for (const [i, call] of (script.toolCalls ?? []).entries()) {
            const toolCallId = `call-${n}-${i}`;
            yield { type: 'tool-call', toolCallId, toolName: call.name, input: call.input };
            // SDK 语义:execute 抛错转成 tool-error 部件,流不终结。
            try {
              const output = await opts.tools[call.name]!.execute(call.input, { toolCallId });
              yield { type: 'tool-result', toolCallId, toolName: call.name, output };
            } catch (error) {
              yield { type: 'tool-error', toolCallId, toolName: call.name, error };
            }
          }
          await onStream?.(n);
          yield { type: 'finish', totalUsage: {}, finishReason: 'stop' };
        })(),
        responseMessages: Promise.resolve([{ role: 'assistant', content: `回复${n}` }]),
        finishReason: Promise.resolve('stop'),
      };
    },
  );
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.on((e) => events.push(e));
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
    config: {
      maxSteps: 24,
      temperature: 0,
      compactThreshold: 0.8,
      providers: { test: { vision: true } },
    } as never,
    systemPrompt: 'sys',
    tools: {},
    bus,
    ...overrides,
  });
  return { agent, bus, events };
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);

beforeEach(() => {
  mockStreamText.mockReset();
  mockCompactMessages.mockReset();
  mockShouldCompact.mockReset().mockReturnValue(false);
  mockEstimateTokens.mockReset().mockReturnValue(0);
  calls.length = 0;
  scripts = [];
  onStream = undefined;
  installStream();
});

describe('HookRegistry', () => {
  it('tool_call 按注册顺序执行,第一个否决即返回,后面的不再跑', async () => {
    const hooks = new HookRegistry();
    const order: string[] = [];
    hooks.on('tool_call', () => {
      order.push('a');
    });
    hooks.on('tool_call', () => {
      order.push('b');
      return { block: true, reason: 'no' };
    });
    hooks.on('tool_call', () => {
      order.push('c');
    });
    const veto = await hooks.toolCall({ callId: '1', toolName: 'x', input: {}, subagent: false });
    expect(veto).toEqual({ block: true, reason: 'no' });
    expect(order).toEqual(['a', 'b']);
  });

  it('tool_call 处理器抛错视同否决(fail closed),并经 onError 上报一次', async () => {
    const failures: HookFailure[] = [];
    const hooks = new HookRegistry((f) => failures.push(f));
    hooks.on('tool_call', () => {
      throw new Error('boom');
    });
    const veto = await hooks.toolCall({ callId: '1', toolName: 'x', input: {}, subagent: false });
    expect(veto?.block).toBe(true);
    expect(veto?.reason).toContain('tool_call');
    expect(veto?.reason).toContain('boom');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.hook).toBe('tool_call');
  });

  it('tool_result 串行改写,后一个看到前一个的产物;抛错的保留当前值(fail open)', async () => {
    const failures: HookFailure[] = [];
    const hooks = new HookRegistry((f) => failures.push(f));
    const seen: unknown[] = [];
    hooks.on('tool_result', ({ output }) => {
      seen.push(output);
      return { output: `${String(output)}+1` };
    });
    hooks.on('tool_result', () => {
      throw new Error('bad rewriter');
    });
    hooks.on('tool_result', ({ output }) => {
      seen.push(output);
      return { output: `${String(output)}+2` };
    });
    const out = await hooks.toolResult({
      callId: '1',
      toolName: 'x',
      input: {},
      output: 'raw',
      isError: false,
      subagent: false,
    });
    expect(out).toBe('raw+1+2');
    expect(seen).toEqual(['raw', 'raw+1']);
    expect(failures.map((f) => f.hook)).toEqual(['tool_result']);
  });

  it('before_agent_start 串行改写系统提示词;返回 undefined 的处理器不改', async () => {
    const hooks = new HookRegistry();
    hooks.on('before_agent_start', ({ systemPrompt }) => ({ systemPrompt: `${systemPrompt}\nA` }));
    hooks.on('before_agent_start', () => undefined);
    hooks.on('before_agent_start', ({ systemPrompt }) => ({ systemPrompt: `${systemPrompt}\nB` }));
    expect((await hooks.beforeAgentStart({ systemPrompt: 'base', subagent: false })).systemPrompt).toBe(
      'base\nA\nB',
    );
  });

  it('has() 反映是否有人在听;注销后为 false', () => {
    const hooks = new HookRegistry();
    expect(hooks.has('turn_end')).toBe(false);
    const off = hooks.on('turn_end', () => {});
    expect(hooks.has('turn_end')).toBe(true);
    off();
    expect(hooks.has('turn_end')).toBe(false);
  });

  it('通知型钩子的异常单独上报,不影响后面的处理器', async () => {
    const failures: HookFailure[] = [];
    const hooks = new HookRegistry((f) => failures.push(f));
    const ran: string[] = [];
    hooks.on('turn_end', () => {
      throw new Error('x');
    });
    hooks.on('turn_end', () => {
      ran.push('second');
    });
    await hooks.notify('turn_end', { outcome: 'completed', subagent: false });
    expect(ran).toEqual(['second']);
    expect(failures).toHaveLength(1);
  });
});

describe('Agent × 工具钩子', () => {
  it('没有工具钩子时原 tools 对象直达 SDK(零开销路径)', async () => {
    const tools = { echo: { execute: async (input: unknown) => input } };
    const hooks = new HookRegistry();
    hooks.on('turn_end', () => {}); // 有别的钩子也不触发包装
    const { agent } = makeAgent({ tools, hooks });
    await agent.run('hi');
    expect(calls[0]!.tools).toBe(tools);
  });

  it('tool_call 否决:execute 不跑,tool-end 是带 reason 的错误,整轮照常收尾', async () => {
    const execute = vi.fn(async () => 'should not run');
    const hooks = new HookRegistry();
    hooks.on('tool_call', ({ toolName }) =>
      toolName === 'danger' ? { block: true, reason: 'Blocked by policy.' } : undefined,
    );
    scripts = [{ toolCalls: [{ name: 'danger', input: { cmd: 'rm' } }] }];
    const { agent, events } = makeAgent({ tools: { danger: { execute } }, hooks });
    await agent.run('go');

    expect(execute).not.toHaveBeenCalled();
    const end = events.find((e) => e.type === 'tool-end');
    expect(end).toMatchObject({ toolName: 'danger', isError: true, output: 'Blocked by policy.' });
    expect(types(events)).toContain('turn-end');
  });

  it('tool_result 改写:模型收到的是改写后的结果,tool-end 也是', async () => {
    const hooks = new HookRegistry();
    hooks.on('tool_result', ({ toolName, output }) =>
      toolName === 'read' ? { output: `${String(output)}\n[diagnostics: 1 error]` } : undefined,
    );
    scripts = [{ toolCalls: [{ name: 'read', input: { path: 'a.ts' } }] }];
    const { agent, events } = makeAgent({
      tools: { read: { execute: async () => 'content' } },
      hooks,
    });
    await agent.run('go');
    const end = events.find((e) => e.type === 'tool-end');
    expect(end).toMatchObject({ isError: false, output: 'content\n[diagnostics: 1 error]' });
  });

  it('工具抛错时 tool_result 看到 isError 与错误消息;没改写就原样抛', async () => {
    const hooks = new HookRegistry();
    const seen: Array<{ isError: boolean; output: unknown }> = [];
    hooks.on('tool_result', ({ isError, output }) => {
      seen.push({ isError, output });
    });
    scripts = [{ toolCalls: [{ name: 'bad', input: {} }] }];
    const { agent, events } = makeAgent({
      tools: {
        bad: {
          execute: async () => {
            throw new Error('exploded');
          },
        },
      },
      hooks,
    });
    await agent.run('go');
    expect(seen).toEqual([{ isError: true, output: 'exploded' }]);
    expect(events.find((e) => e.type === 'tool-end')).toMatchObject({ isError: true, output: 'exploded' });
  });

  it('包装每次开流现做:开流之间就地并进 tools 的新工具也被包住', async () => {
    const tools: Record<string, ToolLike> = { a: { execute: async () => 'A' } };
    const hooks = new HookRegistry();
    const seen: string[] = [];
    hooks.on('tool_call', ({ toolName }) => {
      seen.push(toolName);
    });
    scripts = [{ toolCalls: [{ name: 'a', input: {} }] }, { toolCalls: [{ name: 'b', input: {} }] }];
    const { agent } = makeAgent({ tools, hooks });
    await agent.run('one');
    tools.b = { execute: async () => 'B' }; // MCP 连上 / skill 重建的同款就地改键
    await agent.run('two');
    expect(seen).toEqual(['a', 'b']);
    expect(calls[1]!.tools).not.toBe(tools); // 有钩子时交给 SDK 的是包装副本
  });

  it('子 agent 的钩子输入带 subagent: true', async () => {
    const hooks = new HookRegistry();
    const flags: boolean[] = [];
    hooks.on('tool_call', ({ subagent }) => {
      flags.push(subagent);
    });
    hooks.on('turn_end', ({ subagent }) => {
      flags.push(subagent);
    });
    scripts = [{ toolCalls: [{ name: 'a', input: {} }] }];
    const { agent } = makeAgent({ tools: { a: { execute: async () => 1 } }, hooks, subagent: true });
    await agent.run('go');
    expect(flags).toEqual([true, true]);
  });
});

describe('Agent × before_agent_start', () => {
  it('开流时 system 是钩子改写后的;核心那份 options.systemPrompt 不受影响', async () => {
    const hooks = new HookRegistry();
    hooks.on('before_agent_start', ({ systemPrompt }) => ({ systemPrompt: `${systemPrompt}\n## Todo` }));
    const { agent } = makeAgent({ hooks });
    await agent.run('hi');
    expect(calls[0]!.system).toBe('sys\n## Todo');
    // 第二次开流再过一遍钩子,不会叠加两次。
    await agent.run('again');
    expect(calls[1]!.system).toBe('sys\n## Todo');
  });
});

describe('Agent × followUp 链', () => {
  it('turn_end 里排的 followUp 作为新一轮开跑:两组 turn-start/turn-end、isRunning 全程为真、agent_end 只发一次', async () => {
    const hooks = new HookRegistry();
    const running: boolean[] = [];
    const ends: unknown[] = [];
    let turns = 0;
    const { agent, events } = makeAgent({ hooks });
    hooks.on('turn_end', (input) => {
      turns += 1;
      running.push(agent.isRunning);
      if (turns === 1) agent.followUp('继续', { display: '/goal 续跑' });
      return input.outcome === 'completed' ? undefined : undefined;
    });
    hooks.on('agent_end', (input) => {
      ends.push(input);
    });
    await agent.run('开始');

    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages).toEqual(['开始', '回复1', '继续']);
    expect(types(events).filter((t) => t === 'turn-start')).toHaveLength(2);
    expect(types(events).filter((t) => t === 'turn-end')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'turn-start')[1]).toMatchObject({ userText: '继续', display: '/goal 续跑' });
    expect(running).toEqual([true, true]);
    expect(ends).toEqual([{ aborted: false, followUpsDropped: 0, subagent: false }]);
    expect(agent.isRunning).toBe(false);
    expect(agent.history.map((m) => m.content)).toEqual(['开始', '回复1', '继续', '回复2']);
  });

  it('两轮之间 abort:排好的 followUp 丢弃,补发 aborted,agent_end 报 aborted 与丢弃数', async () => {
    const hooks = new HookRegistry();
    const ends: unknown[] = [];
    const { agent, events } = makeAgent({ hooks });
    let turns = 0;
    hooks.on('turn_end', () => {
      turns += 1;
      if (turns === 1) {
        agent.followUp('续跑 1');
        agent.followUp('续跑 2');
        agent.abort(); // 用户在评估期间按了 esc
      }
    });
    hooks.on('agent_end', (input) => {
      ends.push(input);
    });
    await agent.run('开始');

    expect(calls).toHaveLength(1);
    expect(types(events)).toEqual(['turn-start', 'turn-end', 'aborted', 'run-end']);
    expect(ends).toEqual([{ aborted: true, followUpsDropped: 2, subagent: false }]);
    expect(agent.isRunning).toBe(false);
  });

  it('轮内出错时排好的 followUp 一并丢弃,不会在错误之后自己续跑', async () => {
    const hooks = new HookRegistry();
    const ends: unknown[] = [];
    const { agent, events } = makeAgent({ hooks });
    hooks.on('turn_start', () => {
      agent.followUp('错误之后的续跑');
    });
    hooks.on('agent_end', (input) => {
      ends.push(input);
    });
    onStream = (call) => {
      if (call === 1) throw new Error('provider down');
    };
    await agent.run('开始');

    expect(calls).toHaveLength(1);
    expect(types(events)).toContain('error');
    expect(ends).toEqual([{ aborted: false, followUpsDropped: 1, subagent: false }]);
  });

  it('turn_end 期间注入的引导没有 followUp 可搭时单独续跑:不发第二个 turn-start', async () => {
    const hooks = new HookRegistry();
    const { agent, events } = makeAgent({ hooks });
    let turns = 0;
    const injected: boolean[] = [];
    hooks.on('turn_end', async () => {
      turns += 1;
      if (turns === 1) injected.push(await agent.inject('补充一句'));
    });
    await agent.run('开始');

    expect(injected).toEqual([true]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages).toEqual(['开始', '回复1', wrapGuidance('补充一句')]);
    expect(types(events).filter((t) => t === 'turn-start')).toHaveLength(1);
    expect(types(events).filter((t) => t === 'turn-end')).toHaveLength(2);
    expect(agent.history.map((m) => m.content)).toEqual(['开始', '回复1', wrapGuidance('补充一句'), '回复2']);
  });

  it('链条进行中(两轮之间)提交的消息走 inject,进下一轮而不是并发起第二个链条', async () => {
    const hooks = new HookRegistry();
    const { agent, events } = makeAgent({ hooks });
    let turns = 0;
    let secondRun: Promise<void> | undefined;
    hooks.on('turn_end', () => {
      turns += 1;
      if (turns === 1) {
        agent.followUp('续跑');
        secondRun = agent.run('用户此刻发的话');
      }
    });
    await agent.run('开始');
    await secondRun;

    // 两个流、两个 turn-start:用户的话以引导形式搭上了续跑那一轮(mock 像
    // 真 SDK 一样在开流前过 prepareStep,引导在那个步骤边界就注入了),没有
    // 并发起第二个链条。
    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages).toEqual(['开始', '回复1', '续跑', wrapGuidance('用户此刻发的话')]);
    expect(types(events).filter((t) => t === 'turn-start')).toHaveLength(2);
  });

  it('空闲时 followUp 直接开一轮', async () => {
    const hooks = new HookRegistry();
    const { agent, events } = makeAgent({ hooks });
    const done = new Promise<void>((resolve) => {
      hooks.on('agent_end', () => resolve());
    });
    agent.followUp('自己开跑');
    await done;
    expect(calls).toHaveLength(1);
    expect(types(events)).toEqual(['turn-start', 'turn-end', 'run-end']);
  });

  it('turn_end 输入如实带出结局:completed 有 finishReason,aborted/error 各自标记', async () => {
    const hooks = new HookRegistry();
    const outcomes: unknown[] = [];
    hooks.on('turn_end', ({ outcome, finishReason, error }) => {
      outcomes.push({ outcome, finishReason, error: error?.message });
    });
    const { agent } = makeAgent({ hooks });
    await agent.run('ok');
    onStream = () => {
      throw new Error('boom');
    };
    await agent.run('bad');
    // 真实 SDK 在 abort 后以 AbortError 拒绝收尾 Promise;mock 用抛错模拟。
    onStream = () => {
      agent.abort();
      throw new Error('The operation was aborted');
    };
    await agent.run('stop');
    expect(outcomes).toEqual([
      { outcome: 'completed', finishReason: 'stop', error: undefined },
      { outcome: 'error', finishReason: undefined, error: 'boom' },
      { outcome: 'aborted', finishReason: undefined, error: undefined },
    ]);
  });
});

describe('Agent × Pi 对齐的钩子', () => {
  it('input:transform 换掉进对话的文本;handled 则这一轮根本不开', async () => {
    const hooks = new HookRegistry();
    hooks.on('input', ({ text }) =>
      text.startsWith('!') ? { action: 'handled' } : { action: 'transform', text: `${text} (改写)` },
    );
    const { agent, events } = makeAgent({ hooks });
    await agent.run('hi');
    expect(calls[0]!.messages).toEqual(['hi (改写)']);
    await agent.run('!swallow');
    expect(calls).toHaveLength(1);
    expect(types(events).filter((t) => t === 'turn-start')).toHaveLength(1);
  });

  it('input:扩展经 followUp 发起的消息(source extension)不过钩子;引导注入过 guidance', async () => {
    const hooks = new HookRegistry();
    const seen: string[] = [];
    hooks.on('input', ({ text, source }) => {
      seen.push(`${source}:${text}`);
      return undefined;
    });
    const { agent } = makeAgent({ hooks });
    onStream = async (n) => {
      if (n === 1) await agent.inject('steer');
    };
    let followed = false;
    hooks.on('turn_end', () => {
      if (followed) return;
      followed = true;
      agent.followUp('ext', { source: 'extension' });
    });
    await agent.run('first');
    expect(calls).toHaveLength(3); // first / steer 续跑 / ext
    expect(seen).toEqual(['turn:first', 'guidance:steer']);
  });

  it('context:改写的是这次发出去的消息,持久历史不动;每步只跑一次', async () => {
    const hooks = new HookRegistry();
    let fired = 0;
    hooks.on('context', ({ messages }) => {
      fired += 1;
      return { messages: messages.slice(-1) };
    });
    const { agent } = makeAgent({ hooks });
    await agent.run('one');
    await agent.run('two');
    expect(calls[1]!.messages).toEqual(['two']);
    expect(agent.history).toHaveLength(4); // one / 回复1 / two / 回复2
    // 一步一次:开流前再跑一遍会把第一步的消息改写两次。
    expect(fired).toBe(2);
  });

  it('message_end:并入历史前替换定稿消息', async () => {
    const hooks = new HookRegistry();
    hooks.on('message_end', ({ message }) =>
      message.role === 'assistant' ? { message: { role: 'assistant', content: '被替换' } } : undefined,
    );
    const { agent } = makeAgent({ hooks });
    await agent.run('hi');
    expect(agent.history[1]).toEqual({ role: 'assistant', content: '被替换' });
  });

  it('message_start / message_update:按 step 开一条部分消息,增量按 part id 累积;没人听不组装', async () => {
    const hooks = new HookRegistry();
    const starts: unknown[] = [];
    const updates: Array<{ content: unknown; delta: unknown }> = [];
    hooks.on('message_start', ({ message }) => {
      starts.push(structuredClone(message));
    });
    hooks.on('message_update', ({ message, delta }) => {
      updates.push({ content: structuredClone(message.content), delta });
    });
    const { agent } = makeAgent({ hooks });
    scripts = [{ reasoning: ['think'], text: ['hel', 'lo'] }];
    await agent.run('hi');
    expect(starts).toEqual([{ role: 'assistant', content: [] }]);
    expect(updates.map((u) => u.delta)).toEqual([
      { type: 'reasoning', id: 'r1', text: 'think' },
      { type: 'text', id: 't1', text: 'hel' },
      { type: 'text', id: 't1', text: 'lo' },
    ]);
    expect(updates.at(-1)!.content).toEqual([
      { type: 'reasoning', text: 'think' },
      { type: 'text', text: 'hello' },
    ]);
  });

  it('before_agent_start 的 message 只在本轮首个流注入,进历史', async () => {
    const hooks = new HookRegistry();
    hooks.on('before_agent_start', ({ userText }) => ({ message: `context for ${userText}` }));
    const { agent } = makeAgent({ hooks });
    onStream = async (n) => {
      if (n === 1) await agent.inject('steer'); // 触发第二个流
    };
    await agent.run('hi');
    const texts = calls.map((c) => c.messages);
    expect(texts[0]).toEqual(['hi', 'context for hi']);
    // 第二个流不再注入。
    expect(texts[1]!.filter((m) => m.startsWith('context for'))).toHaveLength(1);
  });

  it('session_before_compact 可取消手动与开轮压缩;session_compact 报结果', async () => {
    const hooks = new HookRegistry();
    let cancel = true;
    const done: string[] = [];
    hooks.on('session_before_compact', () => ({ cancel }));
    hooks.on('session_compact', ({ reason, removedMessages }) => {
      done.push(`${reason}:${removedMessages}`);
    });
    mockCompactMessages.mockResolvedValue({
      messages: [{ role: 'user', content: 'summary' }],
      removedMessages: 3,
      summaryChars: 7,
    });
    const { agent } = makeAgent({ hooks });
    await agent.run('a');
    await agent.compact();
    expect(mockCompactMessages).not.toHaveBeenCalled();
    cancel = false;
    await agent.compact();
    expect(mockCompactMessages).toHaveBeenCalledTimes(1);
    expect(done).toEqual(['manual:3']);
  });

  it('tool_execution_start / end 在 tool_call 之后、tool_result 之前,带原始结果', async () => {
    const hooks = new HookRegistry();
    const order: string[] = [];
    hooks.on('tool_call', () => {
      order.push('call');
    });
    hooks.on('tool_execution_start', ({ toolName }) => {
      order.push(`start:${toolName}`);
    });
    hooks.on('tool_execution_end', ({ output, isError }) => {
      order.push(`end:${String(output)}:${isError}`);
    });
    hooks.on('tool_result', () => {
      order.push('result');
      return { output: 'rewritten' };
    });
    scripts = [{ toolCalls: [{ name: 'a', input: {} }] }];
    const { agent } = makeAgent({ tools: { a: { execute: async () => 'raw' } }, hooks });
    await agent.run('go');
    expect(order).toEqual(['call', 'start:a', 'end:raw:false', 'result']);
  });

  it('只注册 tool_execution_end 也会触发包装', async () => {
    const hooks = new HookRegistry();
    const seen: string[] = [];
    hooks.on('tool_execution_end', ({ toolName }) => {
      seen.push(toolName);
    });
    scripts = [{ toolCalls: [{ name: 'a', input: {} }] }];
    const { agent } = makeAgent({ tools: { a: { execute: async () => 1 } }, hooks });
    await agent.run('go');
    expect(seen).toEqual(['a']);
  });

  it('agent_start 在首轮 turn-start 之前,一次链条只发一次', async () => {
    const hooks = new HookRegistry();
    const order: string[] = [];
    hooks.on('agent_start', () => {
      order.push('agent_start');
    });
    hooks.on('turn_start', () => {
      order.push('turn_start');
    });
    hooks.on('turn_end', () => {
      if (order.filter((o) => o === 'turn_start').length === 1) agent.followUp('more');
    });
    const { agent } = makeAgent({ hooks });
    await agent.run('go');
    expect(order).toEqual(['agent_start', 'turn_start', 'turn_start']);
  });

  it('activeTools:停用的工具不交给 SDK,tools 对象本身不动;没停用时原对象直达(零拷贝)', async () => {
    const tools = { a: { execute: async () => 1 }, b: { execute: async () => 2 } };
    let active: Set<string> | undefined;
    const { agent } = makeAgent({ tools, activeTools: () => active });
    await agent.run('none');
    // 常态(谁都没调 setActiveTools):原对象直达,不白重建一遍工具集。
    expect(calls[0]!.tools).toBe(tools);
    active = new Set(['a']);
    await agent.run('go');
    expect(Object.keys(calls[1]!.tools)).toEqual(['a']);
    expect(Object.keys(tools)).toEqual(['a', 'b']);
  });

  it('before_provider_request:经中间件改写发给 provider 的参数', async () => {
    const hooks = new HookRegistry();
    hooks.on('before_provider_request', ({ params }) => ({
      params: { ...params, headers: { 'x-trace': '1' } } as typeof params,
    }));
    const { agent } = makeAgent({ hooks, model: { id: 'm' } as never });
    await agent.run('go');
    const model = calls[0]!.model as {
      middleware: { transformParams: (o: { params: object; type: string }) => Promise<object> };
    };
    expect(await model.middleware.transformParams({ params: { prompt: [] }, type: 'stream' })).toEqual({
      prompt: [],
      headers: { 'x-trace': '1' },
    });
  });

  it('after_provider_response:流与非流的应答元数据都经中间件交给钩子', async () => {
    const hooks = new HookRegistry();
    const seen: Array<{ type: string; response: unknown }> = [];
    hooks.on('after_provider_response', ({ type, response }) => {
      seen.push({ type, response });
    });
    const { agent } = makeAgent({ hooks, model: { id: 'm' } as never });
    await agent.run('go');
    const model = calls[0]!.model as {
      middleware: {
        wrapStream: (o: { doStream: () => Promise<unknown>; params: object }) => Promise<unknown>;
        wrapGenerate: (o: { doGenerate: () => Promise<unknown>; params: object }) => Promise<unknown>;
        transformParams?: unknown;
      };
    };
    expect(model.middleware.transformParams).toBeUndefined(); // 没人听 before_provider_request 就不装
    await model.middleware.wrapStream({
      doStream: async () => ({ stream: 's', response: { headers: { 'x-req': '1' } } }),
      params: {},
    });
    await model.middleware.wrapGenerate({ doGenerate: async () => ({ response: { id: 'r' } }), params: {} });
    expect(seen).toEqual([
      { type: 'stream', response: { headers: { 'x-req': '1' } } },
      { type: 'generate', response: { id: 'r' } },
    ]);
  });

  it('agent_settled 在 agent_end 之后、且确认空闲时才发;agent_end 里又开链条则等下一次', async () => {
    const hooks = new HookRegistry();
    const order: string[] = [];
    let reopened = false;
    hooks.on('agent_end', () => {
      order.push('end');
      if (!reopened) {
        reopened = true;
        agent.followUp('again');
      }
    });
    hooks.on('agent_settled', () => {
      order.push('settled');
    });
    const { agent } = makeAgent({ hooks });
    await agent.run('go');
    // 第一条链的 agent_end 里开了第二条链:第一次不 settled;第二条链自己收尾后再等一拍。
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['end', 'end', 'settled']);
  });

  it('sendMessage:triggerTurn 开轮(带信封与 display);空闲不开轮直接进历史并播报;运行中注入为引导', async () => {
    const { agent, events } = makeAgent({});
    await agent.sendMessage('note', 'remember this', { display: 'note!' });
    expect(agent.history).toEqual([{ role: 'user', content: wrapCustomMessage('note', 'remember this') }]);
    expect(events.at(-1)).toEqual({ type: 'custom-message', customType: 'note', content: 'remember this', display: 'note!' });
    expect(unwrapCustomMessage(wrapCustomMessage('note', 'a\nb'))).toEqual({ customType: 'note', content: 'a\nb' });
    expect(unwrapCustomMessage('plain')).toBeUndefined();

    await agent.sendMessage('cmd', 'run it', { triggerTurn: true });
    const start = events.find((e) => e.type === 'turn-start');
    expect(start).toMatchObject({ userText: wrapCustomMessage('cmd', 'run it'), display: 'run it' });
    expect(calls[0]!.messages).toEqual([wrapCustomMessage('note', 'remember this'), wrapCustomMessage('cmd', 'run it')]);

    onStream = async (n) => {
      if (n === 2) await agent.sendMessage('steer', 'mid-turn');
    };
    await agent.run('second');
    // 运行中:作为引导注入,续跑的流看到套了引导信封的自定义消息。
    expect(calls[2]!.messages.at(-1)).toBe(wrapGuidance(wrapCustomMessage('steer', 'mid-turn')));
    expect(events.filter((e) => e.type === 'custom-message')).toHaveLength(2);
  });

  it('input 钩子每条消息只跑一次:运行中提交走 inject 那条路也不重复,改写只应用一次', async () => {
    const hooks = new HookRegistry();
    const seen: string[] = [];
    hooks.on('input', ({ text, source }) => {
      seen.push(`${source}:${text}`);
      return { action: 'transform', text: `${text}+` };
    });
    const { agent } = makeAgent({ hooks });
    onStream = async (n) => {
      // 运行中调 run():内部转成 inject,钩子已在 run 里跑过,不能再跑一遍。
      if (n === 1) await agent.run('mid');
    };
    await agent.run('first');
    expect(seen).toEqual(['turn:first', 'guidance:mid']);
    // 改写各只应用一次(不是 first++ / mid++);第二个流是引导续跑,历史里
    // 已经有首答。
    expect(calls[0]!.messages).toEqual(['first+']);
    expect(calls[1]!.messages).toEqual(['first+', '回复1', wrapGuidance('mid+')]);
  });

  it('whenIdle:压缩没发 compaction 事件(短历史、被否决)时也照常兑现', async () => {
    let release!: () => void;
    mockCompactMessages.mockImplementation(
      () =>
        new Promise((resolve) => {
          // removedMessages 0 = doCompact 提前返回,**不发** compaction 事件。
          release = () => resolve({ messages: [], removedMessages: 0, summaryChars: 0 });
        }),
    );
    const { agent } = makeAgent({});
    const compacting = agent.compact();
    expect(agent.isCompacting).toBe(true);
    let settled = false;
    const idle = agent.whenIdle().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    release();
    await compacting;
    await idle;
    expect(settled).toBe(true);
  });

  it('sendMessage:压缩进行中时先等它,消息不被整体替换的历史吞掉', async () => {
    let release!: () => void;
    mockCompactMessages.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ messages: [{ role: 'user', content: 'summary' }], removedMessages: 3, summaryChars: 7 });
        }),
    );
    const { agent } = makeAgent({});
    await agent.run('one');
    const compacting = agent.compact();
    const sending = agent.sendMessage('note', 'survive me');
    release();
    await compacting;
    await sending;
    expect(agent.history).toEqual([
      { role: 'user', content: 'summary' },
      { role: 'user', content: wrapCustomMessage('note', 'survive me') },
    ]);
  });

  it('没有 before_provider_request 钩子时模型原样交给 SDK', async () => {
    const model = { id: 'm' };
    const { agent } = makeAgent({ model: model as never, hooks: new HookRegistry() });
    await agent.run('go');
    expect(calls[0]!.model).toBe(model);
  });

  it('处理器收到 ctx(第二个参数),缺省是无 UI 的空上下文', async () => {
    const hooks = new HookRegistry();
    let seen: unknown;
    hooks.on('turn_start', (_input, ctx) => {
      seen = { hasUI: ctx.hasUI, idle: ctx.isIdle() };
    });
    const { agent } = makeAgent({ hooks });
    await agent.run('go');
    expect(seen).toEqual({ hasUI: false, idle: true });
  });
});
