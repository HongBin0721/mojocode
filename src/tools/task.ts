/**
 * `task` 工具:把一个独立子任务委托给子 agent,在全新上下文里执行。
 *
 * 子 agent 复用同一个 Agent 类(同一个循环驱动 TUI、headless、现在还有
 * 子任务),但挂在**自己的 EventBus** 上——它的几十步流式细节不进主时间线,
 * 只有聚合的 task-progress 事件转发到主总线,由渲染层贴在进行中的工具行上。
 * 工具、权限门与主 agent 完全共享:子 agent 的写入/命令照样弹同一个确认框,
 * 计划模式照样锁死写入。唯一带回主对话的是它的最终报告——这正是意义所在:
 * 大范围调研的中间过程不再挤占主上下文。
 *
 * 递归只放一层:子 agent 的工具集不含 task(也不含 todo/exit_plan,那两个
 * 是主会话的状态),由 bootstrap 组装时保证。
 */

import { tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { Agent } from '../agent/loop.js';
import { EventBus } from '../core/events.js';
import type { ResolvedProvider } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { truncate } from './context.js';

/**
 * 子 agent 的类型。general 与主 agent 同一套工具(去 task/todo/exit_plan);
 * explore 只给只读工具(read/glob/grep/web),纯调研任务用它更安全——
 * 连写入确认框都不会弹。
 */
export type TaskMode = 'general' | 'explore';

/** 一次子任务的完整过程,由 bootstrap 落进会话文件供事后回查。 */
export interface TaskTranscript {
  callId: string;
  description: string;
  mode: TaskMode;
  steps: number;
  tokens: number;
  finishReason?: string;
  error?: string;
  messages: ModelMessage[];
}

export interface TaskToolDeps {
  config: Config;
  /** 主总线,只用来转发 task-progress。 */
  bus: EventBus;
  /**
   * 全部惰性 getter,理由同 ToolContext.searchBackend:/model、/provider、
   * 权限切换都会就地改 config/provider,现取现算才拿到当下的值。
   */
  model: () => LanguageModel;
  provider: () => ResolvedProvider;
  /** 子 agent 的系统提示词(不含计划模式段——子 agent 没有 exit_plan)。 */
  systemPrompt: (mode: TaskMode) => string;
  /** 子 agent 的工具集:按类型给,见 TaskMode。 */
  tools: (mode: TaskMode) => ToolSet;
  /** 子 agent 的总消耗,并入主 agent 的会话累计(Agent.addExternalTokens)。 */
  onTokens: (tokens: number) => void;
  /**
   * 子任务收尾(含中断/失败)时上报完整过程。工具结果只带最终报告,过程
   * 从主对话看是黑箱——排查"那个子任务为什么给了错结论"全靠这份落盘。
   */
  onTranscript?: (transcript: TaskTranscript) => void;
}

/** 追加到子 agent 系统提示词末尾的工作方式说明。英文,喂给模型的文本不本地化。 */
export const SUBAGENT_PROMPT = `## Subagent

You are a subagent handling a task delegated by the main agent. Work autonomously:

- You cannot ask the user questions. Make reasonable assumptions and state them in your report.
- Your final message is the ONLY thing returned to the main agent — everything else is discarded.
  Make it self-contained: findings, relevant file paths as \`path:line\`, and clear conclusions.
- Stay within the delegated task. Do not expand scope or start unrelated work.`;

/** explore 类型追加的段落:只读调研,别试图动手。 */
export const EXPLORE_PROMPT = `## Explore mode

This task is read-only research. You only have read/search/web tools — no write, edit or bash.
Do not attempt changes and do not ask for permission to make them; investigate and report.`;

export function createTaskTool(deps: TaskToolDeps) {
  return tool({
    description:
      'Delegate a self-contained task to a subagent that runs in its own fresh context and ' +
      'returns only its final report. Use it when the intermediate work would flood your ' +
      'context: exploring many files, summarizing a subsystem, researching an independent ' +
      'question, or an isolated chunk of implementation. The subagent has the same tools and ' +
      'permissions as you (minus task/todo), but sees NONE of this conversation — write the ' +
      'prompt as a complete standalone brief: the goal, all context it needs, and exactly what ' +
      'the report should contain. Do not use it for quick single-file lookups; read directly. ' +
      "For pure research set mode 'explore': the subagent then gets only read-only tools, " +
      'which is safer and never prompts for write approval.',
    inputSchema: z.object({
      description: z.string().describe('Short label shown to the user (3-8 words).'),
      prompt: z.string().describe('Complete standalone instructions for the subagent.'),
      mode: z
        .enum(['general', 'explore'])
        .default('general')
        .describe("'explore' = read-only research (read/glob/grep/web only); 'general' = full tools."),
    }),
    execute: async ({ description, prompt, mode }, { toolCallId, abortSignal }) => {
      if (abortSignal?.aborted) throw new Error('Task was interrupted before it started.');

      const innerBus = new EventBus();
      // 子任务用自己的步数上限(taskMaxSteps),缺省沿用 maxSteps。克隆 config
      // 只为改这一个值;子任务是有界的,轮中 /think 之类的就地修改赶不上它。
      const maxSteps = deps.config.taskMaxSteps ?? deps.config.maxSteps;
      const agent = new Agent({
        model: deps.model(),
        provider: deps.provider(),
        config: { ...deps.config, maxSteps },
        systemPrompt: deps.systemPrompt(mode),
        tools: deps.tools(mode),
        bus: innerBus,
      });

      let steps = 0;
      let tokens = 0;
      let currentTool: string | undefined;
      /** 整轮的收尾原因。'tool-calls' 表示撞上 maxSteps 被截停,不是自然收工。 */
      let finishReason: string | undefined;
      /** 最近启动的工具调用(旧→新),供 UI 画过程轨迹。 */
      const recentCalls: Array<{ toolName: string; input: unknown }> = [];
      // Agent.run 从不抛错:流级异常以 error 事件呈现后正常收尾。记下最后
      // 一条,子 agent 一个字都没产出时用它当失败原因,而不是含糊的"没结果"。
      let lastError: Error | undefined;

      const emitProgress = (): void => {
        deps.bus.emit({
          type: 'task-progress',
          callId: toolCallId,
          description,
          steps,
          tokens,
          currentTool,
          recentCalls: [...recentCalls],
        });
      };

      innerBus.on((event) => {
        switch (event.type) {
          case 'tool-start':
            currentTool = event.toolName;
            recentCalls.push({ toolName: event.toolName, input: event.input });
            if (recentCalls.length > 3) recentCalls.shift();
            emitProgress();
            break;
          case 'tool-end':
            currentTool = undefined;
            break;
          case 'step-end':
            steps += 1;
            tokens = event.usage.cumulativeTotalTokens;
            emitProgress();
            break;
          case 'turn-end':
            finishReason = event.finishReason;
            break;
          case 'error':
            lastError = event.error;
            break;
          default:
            break;
        }
      });

      // esc 中断主轮时子 agent 必须跟着停,否则它还在后台烧 token、弹确认框。
      const onAbort = (): void => agent.abort();
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      try {
        await agent.run(prompt);
      } finally {
        abortSignal?.removeEventListener('abort', onAbort);
        // 中断/失败也要把已花掉的钱记上——token 确实花了。
        deps.onTokens(tokens);
        // 过程落盘同样不挑收尾方式:中断/失败恰恰是最需要回查的时候。
        deps.onTranscript?.({
          callId: toolCallId,
          description,
          mode,
          steps,
          tokens,
          finishReason,
          ...(lastError ? { error: lastError.message } : {}),
          messages: [...agent.history],
        });
      }

      if (abortSignal?.aborted) throw new Error('Task was interrupted.');

      const result = finalAssistantText(agent.history);
      if (!result) {
        throw new Error(
          lastError
            ? `The subagent failed: ${lastError.message}`
            : 'The subagent finished without producing a report.',
        );
      }

      /**
       * 报告是否可信。拿到文字不等于跑完了:
       * - 'tool-calls' 收尾 = 撞上 maxSteps 被截停,末条 assistant 只有工具调用,
       *   finalAssistantText 往回找到的多半是开头那句"我先 grep 一下"——把它
       *   当结论交给主 agent 是最坏的一种错。
       * - 'length' = 输出被模型的长度上限截断,报告写了一半。
       * - 有 error 事件 = 中途 429/500,后面的活儿根本没干。
       * 三种都照常返回已有内容(有总比没有强),但必须明说不完整,否则主 agent
       * 会把半截调研当成定论。
       */
      const incomplete =
        lastError !== undefined
          ? `The subagent hit an error and stopped early: ${lastError.message}`
          : finishReason === 'tool-calls'
            ? `The subagent ran out of its step budget (${maxSteps} steps) before ` +
              'finishing. The text below is its last message, not a considered final report.'
            : finishReason === 'length'
              ? 'The subagent hit the model output limit; the report is cut off.'
              : undefined;

      return {
        // 与所有其他工具一样封顶:子 agent 存在的意义就是别让中间产物淹没
        // 主上下文,自己却往回灌一份无上限的报告说不过去。
        result: truncate(result),
        steps,
        tokens,
        ...(incomplete ? { incomplete } : {}),
      };
    },
  });
}

/**
 * 子 agent 历史里的最终报告:从后往前找第一条带非空文本的 assistant 消息。
 * 末尾可能跟着 tool 消息(最后一步只调了工具就被步数上限截停),要跳过。
 */
export function finalAssistantText(history: ModelMessage[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]!;
    if (message.role !== 'assistant') continue;
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
    if (text.trim()) return text.trim();
  }
  return undefined;
}
