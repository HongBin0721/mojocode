import {
  streamText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UserContent,
} from 'ai';
import type { ContextUsage, EventBus, UsageSnapshot } from '../core/events.js';
import type { ImageAttachment } from '../app/attachments.js';
import type { ResolvedProvider } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { summarizeToolResult } from '../tools/index.js';
import { mergeProviderOptions, providerOptionsKey, reasoningMapping } from '../model/reasoning.js';
import { compactMessages, estimateTokens, shouldCompact } from './compact.js';
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

/** 运行中排队的一条引导:文本 + 可选图片。 */
interface GuidanceEntry {
  text: string;
  images?: ImageAttachment[];
}

/**
 * 组装用户消息的 content。无图片时保持裸字符串(既有行为零扰动);有图
 * 片时为 parts 数组,图片用 FilePart(ImagePart 在 AI SDK v7 已废弃),
 * data 必须是 base64 字符串——历史经 JSONL 明文往返,Buffer 会 revive
 * 成字节映射对象,恢复会话后第一轮即被 SDK 校验拒绝。
 */
export function buildUserContent(text: string, images?: ImageAttachment[]): UserContent {
  if (!images || images.length === 0) return text;
  return [
    { type: 'text', text },
    ...images.map((image) => ({
      type: 'file' as const,
      mediaType: image.mediaType,
      data: image.data,
      ...(image.filename ? { filename: image.filename } : {}),
    })),
  ];
}

const guidanceMessage = (entry: GuidanceEntry): ModelMessage => ({
  role: 'user',
  content: buildUserContent(wrapGuidance(entry.text), entry.images),
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
  /**
   * 换史/清史/压缩后缓存的本地估算,仅在 lastInputTokens 作废(没有
   * provider 上报数)时作为 contextUsage 的显示回落——恢复会话后计量条
   * 立即有近似读数,下一轮 step-end 会带回真实值。只服务显示,绝不进入
   * shouldCompact 的判断(本地估算的精度约束见 compact.ts)。
   */
  private estimatedTokens = 0;
  private controller: AbortController | undefined;
  /** 运行中用户发来的引导消息,等待下一步开始时注入。 */
  private pendingGuidance: GuidanceEntry[] = [];
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
   * 本轮是否已发过 aborted。中断会走两条路各报一次:fullStream 的 abort
   * 事件,以及首步未完成时 result 的收尾 Promise 以 AbortError 拒绝、被
   * run() 的 catch 接住。两处都得留着(某一步已完成时收尾 Promise 正常
   * 兑现,只剩前者;流开始之前中断则只剩后者),所以在这里去重。
   */
  private abortEmitted = false;
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
   * 但"作废"不等于"当作装得下":两者都清空后 shouldCompact 恒为 false,
   * 而恢复会话已经不再切回记录里的模型,一段长历史恢复到小窗口模型上,
   * 第一轮就会超窗,且 lastInputTokens 仍是 undefined,重试多少次都同样
   * 失败。所以这里用 estimateTokens 粗估一次新历史:超过阈值就置位
   * historyNeedsCompact,让下一轮开轮先压缩。估算只用来*触发*压缩,不用来
   * 判断"不需要压缩"——低估退回原行为,高估最多多跑一次摘要。
   *
   * 累计用量只在换成*另一个会话*时清零(`resetSpend`):同会话内的截断
   * (esc-esc 回退)不清,那些 token 确实花掉了。
   */
  setHistory(messages: ModelMessage[], options?: { resetSpend?: boolean }): void {
    const { provider, config } = this.options;
    this.messages = messages;
    this.lastInputTokens = undefined;
    // 同一次估算两用:超阈值置位压缩标记;存下来给 contextUsage 作显示
    // 回落,恢复会话后计量条不再是误导性的 0。
    const estimated = estimateTokens(messages);
    this.estimatedTokens = estimated;
    this.historyNeedsCompact = estimated > provider.contextWindow * config.compactThreshold;
    if (options?.resetSpend) this.cumulativeTokens = 0;
    this.historyGeneration++;
  }

  /** 会话中途切换模型(`/models`、`/provider`)。历史会保留。 */
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
    this.estimatedTokens = 0;
    this.historyNeedsCompact = false;
    // 累计用量属于被丢弃的那次会话:不清零的话 footer 与 /cost 会把旧账
    // 算到新会话头上(UI 乐观置 0,下一个 step-end 又跳回清空前的数字)。
    this.cumulativeTokens = 0;
    // 进行中的压缩完成后不得把这段已被丢弃的历史写回来。
    this.historyGeneration++;
  }

  get contextUsage(): ContextUsage {
    return {
      used: this.lastInputTokens ?? this.estimatedTokens,
      window: this.options.provider.contextWindow,
    };
  }

  /** 取消进行中的一轮。没有任务在跑时调用也是安全的。 */
  abort(): void {
    this.controller?.abort();
  }

  /** 一轮至多播报一次中断,详见 abortEmitted。 */
  private emitAborted(): void {
    if (this.abortEmitted) return;
    this.abortEmitted = true;
    this.options.bus.emit({ type: 'aborted' });
  }

  /**
   * 运行中插入一条引导消息,在下一个步骤边界(当前模型输出/工具调用
   * 完成后)注入对话。空闲时调用返回 false——调用方应转为发起新一轮。
   */
  inject(text: string, images?: ImageAttachment[]): boolean {
    if (!this.isRunning) return false;
    this.pendingGuidance.push({ text, images });
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
    const result = await compactMessages(this.messages, this.options.model, undefined, (chars) =>
      this.options.bus.emit({ type: 'compaction-progress', chars }),
    );
    if (result.removedMessages === 0) return;
    // 压缩期间历史被换掉了(/new、/clear、恢复会话):这份摘要针对的是
    // 已经不存在的对话,写回去等于让被丢弃的会话复活。
    if (generation !== this.historyGeneration) return;
    this.messages = result.messages;
    this.lastInputTokens = undefined;
    // 压缩后 lastInputTokens 作废,显示回落也得跟着换算到变短的历史上,
    // 否则计量条会把压缩前的占用一直挂到下一轮 step-end。
    this.estimatedTokens = estimateTokens(result.messages);
    this.options.bus.emit({
      type: 'compaction',
      removedMessages: result.removedMessages,
      summaryChars: result.summaryChars,
    });
    this.options.onHistoryChange?.(this.messages);
  }

  async run(
    userText: string,
    options?: { display?: string; images?: ImageAttachment[] },
  ): Promise<void> {
    // 防重入兜底:已在运行时转为注入引导,绝不能并发起第二个流
    // (两个流共享 this.messages,controller 也会被覆盖)。
    if (this.isRunning) {
      this.inject(userText, options?.images);
      return;
    }
    const { bus } = this.options;
    bus.emit({
      type: 'turn-start',
      userText,
      display: options?.display,
      ...(options?.images?.length ? { imageCount: options.images.length } : {}),
    });

    // controller 在任何 await 之前就位:压缩等待期间 isRunning 已为 true,
    // 此时提交的消息走 inject 排队,而不是再起一轮。
    this.pendingGuidance = [];
    this.injectedThisTurn = [];
    this.contextNoticeSent = false;
    this.abortEmitted = false;
    this.controller = new AbortController();

    try {
      // `/compact` 进行中时等它收尾:它完成时会整体替换 this.messages,
      // 先 push 的用户消息会被无声覆盖掉。压缩失败也必须继续走完这一轮——
      // 用户的消息已经回显在时间线上,吞掉它比压不掉严重得多;错误由
      // `/compact` 的调用方自己呈现。
      if (this.compactionInFlight) await this.compactionInFlight.catch(() => undefined);
      await this.maybeCompact();
      this.messages.push({ role: 'user', content: buildUserContent(userText, options?.images) });
      let finish = await this.stream();

      // 末步开始之后注入的引导等不到下一个 prepareStep——立即作为新的
      // 用户消息续跑,否则 UI 已回显"引导已排队"而消息被静默丢弃。
      // 各流的 totalUsage 只覆盖自己那些步:整轮的用量必须逐流累加,
      // 只取最后一个流会把续跑轮的输入(与缓存命中)低估成零头。
      while (this.pendingGuidance.length > 0 && !this.controller.signal.aborted) {
        this.messages.push(...this.pendingGuidance.splice(0).map(guidanceMessage));
        const next = await this.stream();
        if (next) {
          finish = finish
            ? { usage: mergeUsage(finish.usage, next.usage), finishReason: next.finishReason }
            : next;
        }
      }

      // 整轮(含所有续跑的流)结束后才发一次。中断/出错走不到这里,
      // 由 aborted/error 事件收尾,与之前一致。
      if (finish) {
        // 'tool-calls' 收尾 = 末步还想调工具,被 stopWhen 的步数预算截停。
        // 不出声的话任务就是"无解释地突然中断"——工具循环改到一半停下,
        // 用户只能自己猜(子 agent 在 task.ts 对同一信号标记 incomplete)。
        // 放在整轮级而非 stream() 里:引导续跑会换一个流接着跑,那不是截停,
        // 而且每个流都发会在一轮里刷多条。
        // 已中止的轮不发:引导续跑的流被 esc 打断时,它安静地返回 undefined
        // (完成过至少一步的流,SDK 会正常兑现收尾 Promise 而不 reject),
        // finish 还留着上一个流的 'tool-calls'——对刚亲手停下的用户再提示
        // "发消息可继续"是误导。controller 每轮新建,signal 如实反映本轮状态。
        if (finish.finishReason === 'tool-calls' && !this.controller.signal.aborted) {
          bus.emit({
            type: 'notice',
            level: 'warn',
            message: t('notice.stepBudget', { steps: this.options.config.maxSteps }),
          });
        }
        bus.emit({ type: 'turn-end', usage: finish.usage, finishReason: finish.finishReason });
      }
    } catch (error) {
      if (this.controller.signal.aborted) {
        this.emitAborted();
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
    // streamText 的 system 只在开流时读一次。轮中途换了系统提示词(计划获批
    // → setMode)时,要靠 prepareStep 的 instructions 在下一步补下去,否则整条
    // 流会一直用计划模式那份提示词跑完——模型明明已经能改文件,却还在拒绝动手。
    const systemAtStart = systemPrompt;

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
          const compacted = await compactMessages(next, model, undefined, (chars) =>
            bus.emit({ type: 'compaction-progress', chars }),
          );
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

        // 系统提示词没换过时保持返回 {} 的快路径——这是每步都要走的最热的
        // 一段,不为计划模式这一个场景给所有人加开销。
        const changedSystem = this.options.systemPrompt !== systemAtStart;
        if (next === messages && !changedSystem) return {};
        return {
          ...(next === messages ? {} : { messages: next }),
          ...(changedSystem ? { instructions: this.options.systemPrompt } : {}),
        };
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
          this.emitAborted();
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

  /**
   * 把外部消耗(子 agent、评估器之外的旁路调用)并入会话累计,footer、
   * `/cost` 与 goal 的记账才是全貌。只加总量,不动 lastInputTokens——那
   * 描述的是主对话自己的上下文占用,子 agent 的输入不占主窗口。
   */
  addExternalTokens(tokens: number): void {
    if (tokens > 0) this.cumulativeTokens += tokens;
  }

  private usageSnapshot(usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
    /** AI SDK 的用量明细;部分 provider 不报,字段按可选取。 */
    inputTokenDetails?: {
      cacheReadTokens?: number | undefined;
      cacheWriteTokens?: number | undefined;
      noCacheTokens?: number | undefined;
    };
  }): UsageSnapshot {
    return {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      // 不强制归 0:provider 没报缓存明细时保持缺省,渲染端据此不画命中率
      // 段——实测的 0%(压缩后的全量 miss)与"没量过"必须区分开。
      cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens,
      cumulativeTotalTokens: this.cumulativeTokens,
      contextWindow: this.options.provider.contextWindow,
    };
  }
}

/**
 * 合并同一轮内多个流(引导续跑)的收尾用量:输入/输出/缓存逐流相加,
 * 累计量与窗口取最新的——它们描述的是"此刻"的会话状态,不是增量。
 * 缓存是唯一例外:任一流没报缓存明细,和就无从谈起,保持缺省。
 */
function mergeUsage(a: UsageSnapshot, b: UsageSnapshot): UsageSnapshot {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedInputTokens:
      a.cachedInputTokens !== undefined && b.cachedInputTokens !== undefined
        ? a.cachedInputTokens + b.cachedInputTokens
        : undefined,
    cumulativeTotalTokens: b.cumulativeTotalTokens,
    contextWindow: b.contextWindow,
  };
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
