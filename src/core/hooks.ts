/**
 * 扩展钩子:agent 核心在关键节点让扩展**否决或改写**的契约(Pi 式)。
 *
 * 与 EventBus 的分工:bus 是同步、单向、给渲染层看的事实流(text-delta、
 * tool-end……),处理器的返回值没有意义;钩子是异步、按注册顺序串行、
 * 返回值有意义——否决一次工具调用、改写一份工具结果、改一段系统提示词、
 * 在一轮收尾后排队下一轮。功能从核心搬出去成为扩展时,靠的是这一层,
 * 不是 bus。
 *
 * 命名用 Pi 的 snake_case(tool_call / tool_result / before_agent_start …)
 * 而不是 bus 的 kebab-case,两层在代码里一眼可分。
 *
 * 失败策略按钩子的性质定,不是一刀切:
 * - `tool_call` **失败即否决**(fail closed)。核心没有权限系统,它是做拦截的
 *   扩展唯一的卡口,一个抛错的处理器若被当成"放行",等于那个扩展一有 bug
 *   工具就全部裸跑;否决的
 *   错误消息点名钩子,扩展作者第一次调用就能看见。
 * - `tool_result` / `before_agent_start` 失败保留原值(fail open)——结果已经
 *   在手上,改写器坏了不该让一次成功的工具调用变成失败。
 * - `turn_start` / `turn_end` / `agent_end` 纯通知,失败只上报。
 * 所有失败都经 onError 上报一次(bootstrap 转成 bus notice),绝不冒泡到
 * agent 循环里。
 */

import { toError } from './errors.js';
import type { UsageSnapshot } from './events.js';

/** 每个钩子输入都带的调用方信息。 */
export interface HookAgentInfo {
  /**
   * 这次调用来自子 agent(task 工具 / fork 技能)。权限措辞、要不要弹确认、
   * 轮后要不要续跑,扩展都得看它——子 agent 的轮不是用户的轮。
   */
  subagent: boolean;
}

export interface ToolCallHookInput extends HookAgentInfo {
  callId: string;
  toolName: string;
  input: unknown;
}

/** 返回 block 即否决:工具不执行,reason 作为工具错误喂回模型(保持英文)。 */
export type ToolCallHookResult = { block: true; reason: string } | undefined | void;

export interface ToolResultHookInput extends HookAgentInfo {
  callId: string;
  toolName: string;
  input: unknown;
  /** 工具的返回值;isError 时是错误消息字符串。多个处理器串行时看到的是前一个改写后的值。 */
  output: unknown;
  isError: boolean;
}

/** 返回 output 即改写(isError 时改写的是错误消息)。 */
export type ToolResultHookResult = { output: unknown } | undefined | void;

export interface BeforeAgentStartHookInput extends HookAgentInfo {
  /** 核心组装好的系统提示词;多个处理器串行,各自看到前一个的产物。 */
  systemPrompt: string;
}

export type BeforeAgentStartHookResult = { systemPrompt: string } | undefined | void;

export interface TurnStartHookInput extends HookAgentInfo {
  userText: string;
}

export type TurnOutcome = 'completed' | 'aborted' | 'error';

export interface TurnEndHookInput extends HookAgentInfo {
  outcome: TurnOutcome;
  /** completed 时的收尾原因与整轮用量(与 bus 的 turn-end 同源)。 */
  finishReason?: string;
  usage?: UsageSnapshot;
  /** error 时的错误。 */
  error?: Error;
}

export interface AgentEndHookInput extends HookAgentInfo {
  /** 整个链条以中断收尾:轮内 esc,或两轮之间收到的 abort。 */
  aborted: boolean;
  /** 因中断/出错被丢弃的轮后消息数。扩展靠它知道自己排的续跑没有发生。 */
  followUpsDropped: number;
}

/**
 * 会话就位的原因。扩展在这里从会话记录恢复自己的状态(`entries(type)` 读的
 * 已经是新会话的记录):startup 是进程启动(含 `-c`/`-r` 恢复),其余三个
 * 是 TUI 内的 `/new`、`/resume`、`/fork`。
 */
export type SessionStartReason = 'startup' | 'new' | 'resume' | 'fork';

export interface SessionStartHookInput {
  reason: SessionStartReason;
}

export interface HookMap {
  /** 会话就位(启动、/new、/resume、/fork 之后,历史与状态已换好)。 */
  session_start: (input: SessionStartHookInput) => void | Promise<void>;
  /** 会话关闭(dispose)。 */
  session_shutdown: () => void | Promise<void>;
  /** 每次开流前(一轮里引导续跑会再开流,所以可能不止一次):改系统提示词。 */
  before_agent_start: (
    input: BeforeAgentStartHookInput,
  ) => BeforeAgentStartHookResult | Promise<BeforeAgentStartHookResult>;
  /** 工具执行前:否决。 */
  tool_call: (input: ToolCallHookInput) => ToolCallHookResult | Promise<ToolCallHookResult>;
  /** 工具执行后、结果喂回模型前:改写。 */
  tool_result: (input: ToolResultHookInput) => ToolResultHookResult | Promise<ToolResultHookResult>;
  /** 一轮开始(turn-start 之后)。 */
  turn_start: (input: TurnStartHookInput) => void | Promise<void>;
  /**
   * 一轮完全收尾之后(finally 已跑完、历史已落盘)。在这里 `agent.followUp()`
   * 排队的消息会作为下一轮开跑——这是 `/goal` 这类"评估后续跑"的正确挂点,
   * 见 loop.ts 的 run()。
   */
  turn_end: (input: TurnEndHookInput) => void | Promise<void>;
  /** 一次 run() 的整个链条(首轮 + 全部续跑)结束。 */
  agent_end: (input: AgentEndHookInput) => void | Promise<void>;
}

export type HookName = keyof HookMap;

export interface HookFailure {
  hook: HookName;
  error: Error;
}

type Handler<K extends HookName> = HookMap[K];

export class HookRegistry {
  private readonly handlers = new Map<HookName, Set<Handler<HookName>>>();

  constructor(private readonly onError?: (failure: HookFailure) => void) {}

  /** 注册;返回注销函数。同一处理器重复注册只算一次。 */
  on<K extends HookName>(name: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as Handler<HookName>);
    return () => {
      set.delete(handler as Handler<HookName>);
    };
  }

  /** 有没有人在听。loop 用它走零开销路径:没有工具钩子就不包装工具。 */
  has(name: HookName): boolean {
    return (this.handlers.get(name)?.size ?? 0) > 0;
  }

  /** 快照一份:处理器可能在被调用时注销自己,遍历活 Set 会跳项。 */
  private list<K extends HookName>(name: K): Array<Handler<K>> {
    return [...(this.handlers.get(name) ?? [])] as Array<Handler<K>>;
  }

  private report(hook: HookName, err: unknown): Error {
    const error = toError(err);
    try {
      this.onError?.({ hook, error });
    } catch {
      // 上报器自己出错不能再往外冒
    }
    return error;
  }

  /** 第一个否决即返回;处理器抛错视同否决(见文件头的失败策略)。 */
  async toolCall(input: ToolCallHookInput): Promise<{ block: true; reason: string } | undefined> {
    for (const handler of this.list('tool_call')) {
      try {
        const result = await handler(input);
        if (result?.block) return result;
      } catch (err) {
        const error = this.report('tool_call', err);
        return { block: true, reason: `Tool call blocked: a tool_call hook failed (${error.message}).` };
      }
    }
    return undefined;
  }

  /** 串行改写,返回最终的 output;处理器抛错保留当前值。 */
  async toolResult(input: ToolResultHookInput): Promise<unknown> {
    let output = input.output;
    for (const handler of this.list('tool_result')) {
      try {
        const result = await handler({ ...input, output });
        if (result && 'output' in result) output = result.output;
      } catch (err) {
        this.report('tool_result', err);
      }
    }
    return output;
  }

  /** 串行改写,返回最终的系统提示词;处理器抛错保留当前值。 */
  async beforeAgentStart(input: BeforeAgentStartHookInput): Promise<string> {
    let systemPrompt = input.systemPrompt;
    for (const handler of this.list('before_agent_start')) {
      try {
        const result = await handler({ ...input, systemPrompt });
        if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
      } catch (err) {
        this.report('before_agent_start', err);
      }
    }
    return systemPrompt;
  }

  async turnStart(input: TurnStartHookInput): Promise<void> {
    await this.notify('turn_start', input);
  }

  async turnEnd(input: TurnEndHookInput): Promise<void> {
    await this.notify('turn_end', input);
  }

  async agentEnd(input: AgentEndHookInput): Promise<void> {
    await this.notify('agent_end', input);
  }

  async sessionStart(input: SessionStartHookInput): Promise<void> {
    await this.notify('session_start', input);
  }

  async sessionShutdown(): Promise<void> {
    await this.notify('session_shutdown', undefined);
  }

  private async notify<
    K extends 'turn_start' | 'turn_end' | 'agent_end' | 'session_start' | 'session_shutdown',
  >(name: K, input: Parameters<Handler<K>>[0]): Promise<void> {
    for (const handler of this.list(name)) {
      try {
        await (handler as (i: Parameters<Handler<K>>[0]) => void | Promise<void>)(input);
      } catch (err) {
        this.report(name, err);
      }
    }
  }
}
