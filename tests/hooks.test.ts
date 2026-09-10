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
}));

vi.mock('../src/agent/compact.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/compact.js')>()),
  compactMessages: mockCompactMessages,
  shouldCompact: mockShouldCompact,
  estimateTokens: mockEstimateTokens,
}));

import { Agent, wrapGuidance } from '../src/agent/loop.js';

type ToolLike = { execute: (input: unknown, options: { toolCallId: string }) => Promise<unknown> };

/** 每次 streamText 调用的快照:system、交给 SDK 的 tools 对象、消息文本。 */
interface Call {
  system: string;
  tools: Record<string, ToolLike>;
  messages: string[];
}
const calls: Call[] = [];
/** 第 n 次流要"模拟模型"调用的工具(mock 像 SDK 一样自己去 execute)。 */
let scripts: Array<{ toolCalls?: Array<{ name: string; input: unknown }> } | undefined> = [];
/** 每个流开始时的回调,用于在"流进行中"注入/中断/抛错。 */
let onStream: ((call: number) => void | Promise<void>) | undefined;

function installStream() {
  mockStreamText.mockImplementation(
    (opts: { system: string; tools: Record<string, ToolLike>; messages: Array<{ content: unknown }> }) => {
      calls.push({
        system: opts.system,
        tools: opts.tools,
        messages: opts.messages.map((m) => String(m.content)),
      });
      const n = calls.length;
      const script = scripts[n - 1] ?? {};
      return {
        fullStream: (async function* () {
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
    expect(await hooks.beforeAgentStart({ systemPrompt: 'base', subagent: false })).toBe('base\nA\nB');
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
    await hooks.turnEnd({ outcome: 'completed', subagent: false });
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

    // mock 不调 prepareStep,引导要等续跑轮的流结束后再以一个流补上:
    // 三个流、两个 turn-start——用户的话以引导形式进了链条,没有并发起第二个链条。
    expect(calls).toHaveLength(3);
    expect(calls[1]!.messages).toEqual(['开始', '回复1', '续跑']);
    expect(calls[2]!.messages).toEqual(['开始', '回复1', '续跑', '回复2', wrapGuidance('用户此刻发的话')]);
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
