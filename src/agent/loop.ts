import { streamText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import type { EventBus, UsageSnapshot } from '../core/events.js';
import type { ResolvedProvider } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { summarizeToolResult } from '../tools/index.js';
import { mergeProviderOptions, providerOptionsKey, reasoningMapping } from '../model/reasoning.js';
import { compactMessages, shouldCompact } from './compact.js';
import { PermissionDeniedError } from '../permissions/gate.js';
import { t } from '../i18n/index.js';

export interface AgentOptions {
  model: LanguageModel;
  provider: ResolvedProvider;
  config: Config;
  systemPrompt: string;
  tools: ToolSet;
  bus: EventBus;
  /** 每轮结束后以完整历史调用,用于会话持久化。 */
  onHistoryChange?: (messages: ModelMessage[]) => void;
}

/**
 * 运行中插入的引导消息在喂给模型前的包装(与 Claude Code 一致):向模型
 * 说明这是当前轮进行中用户发来的消息,应在继续任务时一并处理,而不是
 * 当作独立的新一轮请求。UI 时间线展示的是未包装的原文;包装后的版本
 * 进入持久历史——那才是模型实际看到的内容。文案保持英文(见 i18n 约定)。
 */
export function wrapGuidance(text: string): string {
  return (
    `The user sent the following message while you were working:\n\n${text}\n\n` +
    'It was sent mid-turn and is surfaced here inside the running turn. ' +
    'Address it as you continue — do not treat it as a brand-new request that replaces the current task.'
  );
}

/**
 * `wrapGuidance` 的逆操作:从持久历史里的包装消息中还原用户原文。
 * 回放会话时用它把引导消息以原文呈现在时间线上;不是包装消息返回 undefined。
 */
export function unwrapGuidance(text: string): string | undefined {
  const prefix = 'The user sent the following message while you were working:\n\n';
  const suffixStart = '\n\nIt was sent mid-turn';
  if (!text.startsWith(prefix)) return undefined;
  const end = text.lastIndexOf(suffixStart);
  if (end < prefix.length) return undefined;
  return text.slice(prefix.length, end);
}

const guidanceMessage = (text: string): ModelMessage => ({
  role: 'user',
  content: wrapGuidance(text),
});

/** 一个流正常收尾时带回的信息,汇总后作为整轮的 turn-end 发出。 */
interface TurnFinish {
  usage: UsageSnapshot;
  finishReason: string;
}

export class Agent {
  private messages: ModelMessage[] = [];
  private cumulativeTokens = 0;
  private lastInputTokens: number | undefined;
  private controller: AbortController | undefined;
  /** 运行中用户发来的引导消息,等待下一步开始时注入。 */
  private pendingGuidance: string[] = [];
  /** 本轮已注入的引导消息,轮末并入持久历史。 */
  private injectedThisTurn: ModelMessage[] = [];
  /** 进行中的压缩。run() 开始前要等它收尾,并发调用共享同一次。 */
  private compactionInFlight: Promise<void> | undefined;
  /**
   * 轮内压缩只作用于发给模型的消息,持久历史 this.messages 仍是超长的;
   * 而压缩后 lastInputTokens 变小,下一轮 maybeCompact 会误判无需压缩,
   * 直接超窗。置位此标记强制下一轮开轮时压缩持久历史。
   */
  private historyNeedsCompact = false;
  /**
   * 本轮是否已提示过"上下文即将占满"。轮内压缩会在每个步骤边界重新判断,
   * 若不加闩锁,一轮长工具循环能把同一条提示刷满整个时间线(上限即 maxSteps)。
   */
  private contextNoticeSent = false;
  /**
   * 历史的代数。`clear()`/`setHistory()` 会递增它,压缩在 await 期间若跨了
   * 代,结果就作废——否则 `/compact` 未完成时执行 `/clear`,压缩返回后会把
   * 被丢弃的对话整体写回内存,并存进那个全新的会话文件。
   */
  private historyGeneration = 0;

  constructor(private readonly options: AgentOptions) {}

  get history(): ModelMessage[] {
    return this.messages;
  }

  /**
   * 换掉整段历史。
   *
   * lastInputTokens 与 historyNeedsCompact 总是作废:它们描述的是被换掉的
   * 那段历史的大小。留着会两头出错——偏小(恢复长会话)让 maybeCompact 误判
   * "不用压缩",第一轮就撑爆窗口;偏大(回退截断)则会拿一段刚刚变短的历史
   * 去跑一次真实的摘要调用,把用户刚回退到的对话又揉成摘要。
   *
   * 累计用量只在换成*另一个会话*时清零(`resetSpend`):同会话内的截断
   * (esc-esc 回退)不清,那些 token 确实花掉了。
   */
  setHistory(messages: ModelMessage[], options?: { resetSpend?: boolean }): void {
    this.messages = messages;
    this.lastInputTokens = undefined;
    this.historyNeedsCompact = false;
    if (options?.resetSpend) this.cumulativeTokens = 0;
    this.historyGeneration++;
  }

  /** 会话中途切换模型(`/model`、`/provider`)。历史会保留。 */
  updateModel(model: LanguageModel, provider: ResolvedProvider): void {
    this.options.model = model;
    this.options.provider = provider;
  }

  updateSystemPrompt(systemPrompt: string): void {
    this.options.systemPrompt = systemPrompt;
  }

  clear(): void {
    this.messages = [];
    this.lastInputTokens = undefined;
    this.historyNeedsCompact = false;
    // 累计用量属于被丢弃的那次会话:不清零的话 footer 与 /cost 会把旧账
    // 算到新会话头上(UI 乐观置 0,下一个 step-end 又跳回清空前的数字)。
    this.cumulativeTokens = 0;
    // 进行中的压缩完成后不得把这段已被丢弃的历史写回来。
    this.historyGeneration++;
  }

  get contextUsage(): { used: number; window: number } {
    return {
      used: this.lastInputTokens ?? 0,
      window: this.options.provider.contextWindow,
    };
  }

  /** 取消进行中的一轮。没有任务在跑时调用也是安全的。 */
  abort(): void {
    this.controller?.abort();
  }

  /**
   * 运行中插入一条引导消息,在下一个步骤边界(当前模型输出/工具调用
   * 完成后)注入对话。空闲时调用返回 false——调用方应转为发起新一轮。
   */
  inject(text: string): boolean {
    if (!this.isRunning) return false;
    this.pendingGuidance.push(text);
    return true;
  }

  get isRunning(): boolean {
    return this.controller !== undefined;
  }

  /** 手动触发压缩,例如来自 `/compact` 命令。并发调用共享同一次压缩。 */
  compact(): Promise<void> {
    this.compactionInFlight ??= this.doCompact().finally(() => {
      this.compactionInFlight = undefined;
    });
    return this.compactionInFlight;
  }

  /** 压缩进行中(`/compact`)。与 isRunning 分开:压缩不设 controller。 */
  get isCompacting(): boolean {
    return this.compactionInFlight !== undefined;
  }

  private async doCompact(): Promise<void> {
    const generation = this.historyGeneration;
    const result = await compactMessages(this.messages, this.options.model);
    if (result.removedMessages === 0) return;
    // 压缩期间历史被换掉了(/new、/clear、恢复会话):这份摘要针对的是
    // 已经不存在的对话,写回去等于让被丢弃的会话复活。
    if (generation !== this.historyGeneration) return;
    this.messages = result.messages;
    this.lastInputTokens = undefined;
    this.options.bus.emit({
      type: 'compaction',
      removedMessages: result.removedMessages,
      summaryChars: result.summaryChars,
    });
    this.options.onHistoryChange?.(this.messages);
  }

  async run(userText: string): Promise<void> {
    // 防重入兜底:已在运行时转为注入引导,绝不能并发起第二个流
    // (两个流共享 this.messages,controller 也会被覆盖)。
    if (this.isRunning) {
      this.inject(userText);
      return;
    }
    const { bus } = this.options;
    bus.emit({ type: 'turn-start', userText });

    // controller 在任何 await 之前就位:压缩等待期间 isRunning 已为 true,
    // 此时提交的消息走 inject 排队,而不是再起一轮。
    this.pendingGuidance = [];
    this.injectedThisTurn = [];
    this.contextNoticeSent = false;
    this.controller = new AbortController();

    try {
      // `/compact` 进行中时等它收尾:它完成时会整体替换 this.messages,
      // 先 push 的用户消息会被无声覆盖掉。压缩失败也必须继续走完这一轮——
      // 用户的消息已经回显在时间线上,吞掉它比压不掉严重得多;错误由
      // `/compact` 的调用方自己呈现。
      if (this.compactionInFlight) await this.compactionInFlight.catch(() => undefined);
      await this.maybeCompact();
      this.messages.push({ role: 'user', content: userText });
      let finish = await this.stream();

      // 末步开始之后注入的引导等不到下一个 prepareStep——立即作为新的
      // 用户消息续跑,否则 UI 已回显"引导已排队"而消息被静默丢弃。
      while (this.pendingGuidance.length > 0 && !this.controller.signal.aborted) {
        this.messages.push(...this.pendingGuidance.splice(0).map(guidanceMessage));
        finish = (await this.stream()) ?? finish;
      }

      // 整轮(含所有续跑的流)结束后才发一次。中断/出错走不到这里,
      // 由 aborted/error 事件收尾,与之前一致。
      if (finish) {
        bus.emit({ type: 'turn-end', usage: finish.usage, finishReason: finish.finishReason });
      }
    } catch (error) {
      if (this.controller.signal.aborted) {
        bus.emit({ type: 'aborted' });
      } else {
        bus.emit({
          type: 'error',
          error: normalizeError(error, this.options.provider),
          recoverable: true,
        });
      }
    } finally {
      // 中断/出错时 stream() 到不了轮末合并——已注入(模型已看过)和仍在
      // 排队的引导都要并入持久历史,否则时间线上有、下一轮历史里却没有。
      const leftovers: ModelMessage[] = [
        ...this.injectedThisTurn,
        ...this.pendingGuidance.splice(0).map(guidanceMessage),
      ];
      if (leftovers.length > 0) this.messages.push(...leftovers);
      this.injectedThisTurn = [];
      this.controller = undefined;
      this.options.onHistoryChange?.(this.messages);
    }
  }

  private async maybeCompact(): Promise<void> {
    const { provider, config } = this.options;
    const need =
      this.historyNeedsCompact ||
      shouldCompact(this.lastInputTokens, provider.contextWindow, config.compactThreshold);
    if (!need) return;
    this.historyNeedsCompact = false;

    this.noticeContextNearFull();
    // 同上:开轮压缩失败不该让这一轮无声消失,提示一下继续跑。
    await this.compact().catch((err: Error) => {
      this.options.bus.emit({
        type: 'notice',
        level: 'warn',
        message: t('notice.compactFailed', { message: err.message }),
      });
    });
  }

  /** "上下文即将占满"每轮最多提示一次,解释停顿即可,不必刷屏。 */
  private noticeContextNearFull(): void {
    if (this.contextNoticeSent) return;
    this.contextNoticeSent = true;
    this.options.bus.emit({ type: 'notice', level: 'info', message: t('notice.contextNearFull') });
  }

  /** 返回这个流的收尾信息(若正常收尾),由 run() 汇总成一次 turn-end。 */
  private async stream(): Promise<TurnFinish | undefined> {
    const { bus, model, config, tools, systemPrompt, provider } = this.options;
    const signal = this.controller!.signal;
    let finish: TurnFinish | undefined;

    // 组装 providerOptions:parallel_tool_calls 与思考强度参数都要写进同一个
    // provider 键,分开展开会整体覆盖,必须先合并再传入。provider 按引用持有,
    // 每次 stream 现读 reasoningEffort,/think 的修改对下一次请求立即生效。
    // 注意:DeepSeek 开启 thinking 时服务端不接受 temperature/top_p,冲突由
    // onError 正常呈现,不做静默剥离。
    const providerOptions = mergeProviderOptions(
      provider.parallelToolCalls
        ? undefined
        : { [providerOptionsKey(provider.id)]: { parallel_tool_calls: false } },
      reasoningMapping(provider, provider.reasoningEffort).providerOptions,
    );

    const result = streamText({
      model,
      system: systemPrompt,
      messages: this.messages,
      tools,
      stopWhen: stepCountIs(config.maxSteps),
      // 每步开始前做两件事:
      // 1. 注入运行中用户发来的引导消息。SDK 会把 prepareStep 返回的消息
      //    带入后续步骤(stepMessagesForNextStep),已注入的引导已经在
      //    `messages` 里——只追加本步新到的,否则每步都会重复一份。
      // 2. 轮内压缩兜底:开轮时的 maybeCompact 管不到长工具循环——一轮跑
      //    几十步工具后上下文可能在轮中撑爆。超阈值就压缩本步要发送的消
      //    息。compactMessages 的切分点对齐到用户消息,不会拆开工具调用与
      //    其结果。持久历史的压缩由下一轮的 maybeCompact 强制完成
      //    (historyNeedsCompact)。
      prepareStep: async ({ messages }) => {
        const fresh = this.pendingGuidance.splice(0).map(guidanceMessage);
        this.injectedThisTurn.push(...fresh);
        let next = fresh.length > 0 ? [...messages, ...fresh] : messages;

        if (shouldCompact(this.lastInputTokens, provider.contextWindow, config.compactThreshold)) {
          this.noticeContextNearFull();
          const compacted = await compactMessages(next, model);
          if (compacted.removedMessages > 0) {
            this.lastInputTokens = undefined;
            this.historyNeedsCompact = true;
            bus.emit({
              type: 'compaction',
              removedMessages: compacted.removedMessages,
              summaryChars: compacted.summaryChars,
            });
            next = compacted.messages;
          }
        }

        return next === messages ? {} : { messages: next };
      },
      abortSignal: signal,
      temperature: config.temperature,
      ...(providerOptions ? { providerOptions } : {}),
      // 工具抛出异常绝不能终结整轮对话:模型需要看到错误才能纠正方向
      // (路径写错、oldString 过期、权限被拒)。把错误消息作为工具输出
      // 返回即可做到这一点。
      onError: ({ error }) => {
        bus.emit({ type: 'error', error: normalizeError(error, provider), recoverable: true });
      },
    });

    const toolStartedAt = new Map<string, number>();

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-start':
          bus.emit({ type: 'text-start', id: part.id });
          break;
        case 'text-delta':
          bus.emit({ type: 'text-delta', id: part.id, text: part.text });
          break;
        case 'text-end':
          bus.emit({ type: 'text-end', id: part.id });
          break;
        case 'reasoning-start':
          bus.emit({ type: 'reasoning-start', id: part.id });
          break;
        case 'reasoning-delta':
          bus.emit({ type: 'reasoning-delta', id: part.id, text: part.text });
          break;
        case 'reasoning-end':
          bus.emit({ type: 'reasoning-end', id: part.id });
          break;
        case 'tool-call':
          toolStartedAt.set(part.toolCallId, Date.now());
          bus.emit({
            type: 'tool-start',
            callId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
          break;
        case 'tool-result':
          bus.emit({
            type: 'tool-end',
            callId: part.toolCallId,
            toolName: part.toolName,
            summary: summarizeToolResult(part.toolName, part.output),
            output: part.output,
            isError: false,
            durationMs: Date.now() - (toolStartedAt.get(part.toolCallId) ?? Date.now()),
          });
          break;
        case 'tool-error': {
          const message = errorMessage(part.error);
          bus.emit({
            type: 'tool-end',
            callId: part.toolCallId,
            toolName: part.toolName,
            summary: message.split('\n')[0]!.slice(0, 120),
            output: message,
            isError: true,
            durationMs: Date.now() - (toolStartedAt.get(part.toolCallId) ?? Date.now()),
          });
          break;
        }
        case 'finish-step':
          this.recordUsage(part.usage.inputTokens, part.usage.outputTokens);
          bus.emit({ type: 'step-end', usage: this.usageSnapshot(part.usage) });
          break;
        case 'finish':
          // 不在这里发 turn-end:引导续跑会为同一轮再起一个流,提前发会让
          // UI 收掉状态行(看起来像卡住了),headless 也会重复打印轮末统计。
          // 记下收尾信息,由 run() 在整轮真正结束时发一次。
          finish = {
            usage: this.usageSnapshot(part.totalUsage),
            finishReason: part.finishReason,
          };
          break;
        case 'abort':
          bus.emit({ type: 'aborted' });
          break;
        default:
          break;
      }
    }

    // `responseMessages` 累积了每一步的 assistant 消息和工具消息。
    // (`result.response.messages` 只包含*最后*一步——用它会丢掉前面各步的
    // 工具调用和结果,下一轮看到的 assistant 就像什么都没做过一样。)
    // 引导消息放在 assistant 消息之前:它们已在轮中被模型看到并处理过,
    // 排在响应之后会像一条未回应的新消息,下一轮模型会再答一遍。
    this.messages.push(...this.injectedThisTurn, ...(await result.responseMessages));
    this.injectedThisTurn = [];

    const finishReason = await result.finishReason;
    if (finishReason === 'length') {
      bus.emit({
        type: 'notice',
        level: 'warn',
        message: t('notice.outputLimit'),
      });
    }

    return finish;
  }

  private recordUsage(inputTokens: number | undefined, outputTokens: number | undefined): void {
    if (inputTokens !== undefined) this.lastInputTokens = inputTokens;
    this.cumulativeTokens += (inputTokens ?? 0) + (outputTokens ?? 0);
  }

  private usageSnapshot(usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  }): UsageSnapshot {
    return {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      cumulativeTotalTokens: this.cumulativeTokens,
      contextWindow: this.options.provider.contextWindow,
    };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof PermissionDeniedError) return error.message;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}

/**
 * 把 provider 的错误转成用户能据此采取行动的信息。三个平台返回的都是
 * OpenAI 形状的错误,但措辞各不相同,原始消息本身通常没什么帮助。
 */
function normalizeError(error: unknown, provider: ResolvedProvider): Error {
  const base = error instanceof Error ? error : new Error(errorMessage(error));
  const text = base.message;

  const params = {
    label: provider.label,
    id: provider.id,
    model: provider.model,
    baseURL: provider.baseURL,
  };
  if (/401|invalid api key|authentication/i.test(text)) {
    return new Error(t('error.auth', params));
  }
  if (/404/.test(text) && /model/i.test(text)) {
    return new Error(t('error.modelNotFound', params));
  }
  if (/404/.test(text)) {
    return new Error(t('error.notFound', params));
  }
  if (/429|rate limit/i.test(text)) {
    return new Error(t('error.rateLimit', params));
  }
  return base;
}
