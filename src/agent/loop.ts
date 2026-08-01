import { streamText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import type { EventBus, UsageSnapshot } from '../core/events.js';
import type { ResolvedProvider } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { summarizeToolResult } from '../tools/index.js';
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
  /** Called after each turn with the full history, for session persistence. */
  onHistoryChange?: (messages: ModelMessage[]) => void;
}

export class Agent {
  private messages: ModelMessage[] = [];
  private cumulativeTokens = 0;
  private lastInputTokens: number | undefined;
  private controller: AbortController | undefined;

  constructor(private readonly options: AgentOptions) {}

  get history(): ModelMessage[] {
    return this.messages;
  }

  setHistory(messages: ModelMessage[]): void {
    this.messages = messages;
  }

  /** Swap the model mid-session (`/model`, `/provider`). History carries over. */
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
  }

  get contextUsage(): { used: number; window: number } {
    return {
      used: this.lastInputTokens ?? 0,
      window: this.options.provider.contextWindow,
    };
  }

  /** Cancels the in-flight turn. Safe to call when nothing is running. */
  abort(): void {
    this.controller?.abort();
  }

  get isRunning(): boolean {
    return this.controller !== undefined;
  }

  /** Manually trigger compaction, e.g. from the `/compact` command. */
  async compact(): Promise<void> {
    const result = await compactMessages(this.messages, this.options.model);
    if (result.removedMessages === 0) return;
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
    const { bus, config } = this.options;
    bus.emit({ type: 'turn-start', userText });

    await this.maybeCompact();

    this.messages.push({ role: 'user', content: userText });
    this.controller = new AbortController();

    try {
      await this.stream();
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
      this.controller = undefined;
      this.options.onHistoryChange?.(this.messages);
      void config;
    }
  }

  private async maybeCompact(): Promise<void> {
    const { provider, config } = this.options;
    if (!shouldCompact(this.lastInputTokens, provider.contextWindow, config.compactThreshold)) return;

    this.options.bus.emit({
      type: 'notice',
      level: 'info',
      message: t('notice.contextNearFull'),
    });
    await this.compact();
  }

  private async stream(): Promise<void> {
    const { bus, model, config, tools, systemPrompt, provider } = this.options;
    const signal = this.controller!.signal;

    const result = streamText({
      model,
      system: systemPrompt,
      messages: this.messages,
      tools,
      stopWhen: stepCountIs(config.maxSteps),
      abortSignal: signal,
      temperature: config.temperature,
      ...(provider.parallelToolCalls ? {} : { providerOptions: { [provider.id]: { parallel_tool_calls: false } } }),
      // A tool throwing must not kill the turn: the model needs to see the
      // error so it can correct course (wrong path, stale oldString, denied
      // permission). Returning the message as the tool output does that.
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
          bus.emit({
            type: 'turn-end',
            usage: this.usageSnapshot(part.totalUsage),
            finishReason: part.finishReason,
          });
          break;
        case 'abort':
          bus.emit({ type: 'aborted' });
          break;
        default:
          break;
      }
    }

    // `responseMessages` accumulates the assistant + tool messages across every
    // step. (`result.response.messages` is the *last* step only — using it drops
    // the tool calls and results from earlier steps, so the next turn would see
    // an assistant that apparently did nothing.)
    this.messages.push(...(await result.responseMessages));

    const finishReason = await result.finishReason;
    if (finishReason === 'length') {
      bus.emit({
        type: 'notice',
        level: 'warn',
        message: t('notice.outputLimit'),
      });
    }
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
 * Turns provider errors into something a user can act on. The three platforms
 * all return OpenAI-shaped errors but with different wording, and the raw
 * message is usually unhelpful on its own.
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
