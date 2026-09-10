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
 * 而不是 bus 的 kebab-case,两层在代码里一眼可分。钩子表与 Pi 的事件表
 * **同名同义**(input / context / message_end / tool_execution_* /
 * session_before_compact / session_compact / model_select …),作者学过 Pi
 * 就会写这里的扩展;Pi 有而这里没有的那些(渲染扩展点、会话树)是结构性
 * 差异,见 docs 的扩展页。
 *
 * 每个处理器都收第二个参数 `ctx`(ExtensionContext,与 Pi 的 ctx 同形):
 * cwd / hasUI / isIdle / abort / ui.* 之类,与 ExtensionAPI 上的同名成员
 * 是同一份实现——只是让「只拿到 handler、没拿到 api」的代码(比如从别的
 * 模块拆出去的处理器)也够得着宿主。
 *
 * 失败策略按钩子的性质定,不是一刀切:
 * - `tool_call` **失败即否决**(fail closed)。核心没有权限系统,它是做拦截的
 *   扩展唯一的卡口,一个抛错的处理器若被当成"放行",等于那个扩展一有 bug
 *   工具就全部裸跑;否决的
 *   错误消息点名钩子,扩展作者第一次调用就能看见。
 * - `tool_result` / `before_agent_start` / `input` / `context` / `message_end`
 *   / `before_provider_request` 失败保留当前值(fail open)——结果已经在手上,
 *   改写器坏了不该让一次成功的工具调用变成失败。
 * - `session_before_compact` 失败视同不取消。
 * - 通知型钩子纯上报。
 * 所有失败都经 onError 上报一次(bootstrap 转成 bus notice),绝不冒泡到
 * agent 循环里。
 */

import type { LanguageModelMiddleware, ModelMessage } from 'ai';
import { toError } from './errors.js';
import type { UsageSnapshot } from './events.js';
import type { ImageAttachment } from '../app/attachments.js';
import type { ExtensionContext } from './extension.js';

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

/** 工具真正开始执行(tool_call 没否决之后)。 */
export interface ToolExecutionStartHookInput extends HookAgentInfo {
  callId: string;
  toolName: string;
  input: unknown;
}

/** 工具执行中的增量输出(目前只有 bash 发;子 agent 的不经主总线,收不到)。 */
export interface ToolExecutionUpdateHookInput extends HookAgentInfo {
  callId: string;
  chunk: string;
}

/** 工具执行完毕(tool_result 改写**之前**的原始结果)。 */
export interface ToolExecutionEndHookInput extends HookAgentInfo {
  callId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  isError: boolean;
  durationMs: number;
}

export interface BeforeAgentStartHookInput extends HookAgentInfo {
  /** 核心组装好的系统提示词;多个处理器串行,各自看到前一个的产物。 */
  systemPrompt: string;
  /** 本轮的用户文本(引导续跑的流没有,为 undefined)。 */
  userText?: string;
}

/**
 * `systemPrompt` 改写发出去的系统提示词;`message` 以一条 user 消息进入本轮
 * 上下文(与 Pi 的 `message` 同义,只在本轮首个流生效——引导续跑再开的流
 * 不重复注入),它会进持久历史。
 */
export type BeforeAgentStartHookResult =
  | { systemPrompt?: string; message?: string }
  | undefined
  | void;

/**
 * 用户输入进入对话之前(Pi 的 `input`):新一轮的首条消息,或运行中提交的
 * 引导。扩展 `run` / `followUp` 发起的消息**不经它**——那已经是扩展自己的
 * 产物;斜杠命令在客户端就解析掉了,到这里的永远是要喂给模型的文本。
 */
export interface InputHookInput extends HookAgentInfo {
  text: string;
  images?: ImageAttachment[];
  /** `turn` = 新一轮的首条消息;`guidance` = 运行中的轮内引导。 */
  source: 'turn' | 'guidance';
}

/**
 * `continue`(或返回 undefined)= 原样;`transform` = 换成 text/images 再
 * 继续给后面的处理器;`handled` = 扩展自己消化了,不进对话(run 直接返回,
 * inject 报"已排队"但什么都不排)。
 */
export type InputHookResult =
  | { action: 'continue' }
  | { action: 'transform'; text: string; images?: ImageAttachment[] }
  | { action: 'handled' }
  | undefined
  | void;

/**
 * 每次调模型之前(Pi 的 `context`):`messages` 是**这次要发出去的**副本
 * (纯文本模型已剥图、轮内压缩已做),改写只影响这一次请求,持久历史不动。
 * 裁剪上下文、注入检索结果都在这里。
 */
export interface ContextHookInput extends HookAgentInfo {
  messages: ModelMessage[];
}

export type ContextHookResult = { messages?: ModelMessage[] } | undefined | void;

/**
 * 一条模型侧消息定稿、并入历史之前(Pi 的 `message_end`):每个流收尾时对
 * 它产生的每条 assistant / tool 消息各调一次。返回 `message` 即替换。
 */
export interface MessageEndHookInput extends HookAgentInfo {
  message: ModelMessage;
}

export type MessageEndHookResult = { message?: ModelMessage } | undefined | void;

/**
 * 发给 provider 的请求参数(Pi 的 `before_provider_request`),经 AI SDK 的
 * 语言模型中间件 `transformParams` 拿到:prompt、tools、providerOptions、
 * headers 全在里面。返回 `params` 即替换——改 headers 也在这里(Pi 的
 * `before_provider_headers` 并进了这一个)。
 */
export type ProviderRequestParams = Parameters<
  NonNullable<LanguageModelMiddleware['transformParams']>
>[0]['params'];

export interface BeforeProviderRequestHookInput extends HookAgentInfo {
  params: ProviderRequestParams;
  /** 'stream' | 'generate'(agent 循环恒为 stream;压缩摘要等旁路调用不经此钩子)。 */
  type: 'stream' | 'generate';
}

export type BeforeProviderRequestHookResult =
  | { params?: ProviderRequestParams }
  | undefined
  | void;

/** 压缩即将发生。 */
export interface SessionBeforeCompactHookInput extends HookAgentInfo {
  /** `manual` = `/compact`;`auto` = 开轮前超阈值;`in-turn` = 轮内步骤边界。 */
  reason: 'manual' | 'auto' | 'in-turn';
  /** 将被压缩的消息(auto/manual 是持久历史;in-turn 是本步要发的副本)。 */
  messages: ModelMessage[];
}

/** 返回 cancel 即跳过这次压缩(auto/in-turn 的下一次仍会再问)。 */
export type SessionBeforeCompactHookResult = { cancel?: boolean } | undefined | void;

export interface SessionCompactHookInput extends HookAgentInfo {
  reason: 'manual' | 'auto' | 'in-turn';
  removedMessages: number;
  summaryChars: number;
}

/** 会话切换了模型(`/models`、`/provider`、扩展的 setModel)。 */
export interface ModelSelectHookInput {
  provider: string;
  model: string;
}

/** 思考档位变了(`/think`、扩展的 setThinkingLevel)。 */
export interface ThinkingLevelSelectHookInput {
  level: string;
}

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

/** 一次 run() 的链条开始(首轮 turn-start 之前)。 */
export interface AgentStartHookInput extends HookAgentInfo {
  userText: string;
}

export interface AgentEndHookInput extends HookAgentInfo {
  /** 整个链条以中断收尾:轮内 esc,或两轮之间收到的 abort。 */
  aborted: boolean;
  /** 因中断/出错被丢弃的轮后消息数。扩展靠它知道自己排的续跑没有发生。 */
  followUpsDropped: number;
}

/** 即将切到另一个会话(`/resume`、扩展的 switchSession)。 */
export interface SessionBeforeSwitchHookInput {
  /** 目标会话 id(或前缀)。 */
  id: string;
}

/** 返回 cancel 即取消切换 / 分叉(调用方收到一个错误)。 */
export type SessionCancelHookResult = { cancel?: boolean } | undefined | void;

/**
 * provider 应答之后(经 AI SDK 中间件的 wrapStream / wrapGenerate):`response`
 * 是 SDK 交回的原始应答元数据(流式时只有 headers 之类,正文在流里)。
 */
export interface AfterProviderResponseHookInput extends HookAgentInfo {
  type: 'stream' | 'generate';
  params: ProviderRequestParams;
  response: unknown;
}

/** 扩展贡献资源目录(Pi 的 resources_discover):目前只认技能目录。 */
export type ResourcesDiscoverHookResult = { skillPaths?: string[] } | undefined | void;

/**
 * 会话就位的原因。扩展在这里从会话记录恢复自己的状态(`entries(type)` 读的
 * 已经是新会话的记录):startup 是进程启动(含 `-c`/`-r` 恢复),其余三个
 * 是 TUI 内的 `/new`、`/resume`、`/fork`。
 */
export type SessionStartReason = 'startup' | 'new' | 'resume' | 'fork';

export interface SessionStartHookInput {
  reason: SessionStartReason;
}

/** 处理器统一的形状:输入 + 上下文。 */
type Hook<I, R = void> = (input: I, ctx: ExtensionContext) => R | Promise<R>;

export interface HookMap {
  /** 会话就位(启动、/new、/resume、/fork 之后,历史与状态已换好)。 */
  session_start: Hook<SessionStartHookInput>;
  /** 会话关闭(dispose)。 */
  session_shutdown: Hook<undefined>;
  /** 用户输入进入对话之前:改写或吞掉。 */
  input: Hook<InputHookInput, InputHookResult>;
  /** 一次 run() 的链条开始。 */
  agent_start: Hook<AgentStartHookInput>;
  /** 每次开流前(一轮里引导续跑会再开流,所以可能不止一次):改系统提示词、注入一条消息。 */
  before_agent_start: Hook<BeforeAgentStartHookInput, BeforeAgentStartHookResult>;
  /** 每次调模型之前:改写这次要发出去的消息。 */
  context: Hook<ContextHookInput, ContextHookResult>;
  /** 发给 provider 的请求参数(经 AI SDK 中间件)。 */
  before_provider_request: Hook<BeforeProviderRequestHookInput, BeforeProviderRequestHookResult>;
  /** 一条模型侧消息定稿、并入历史之前。 */
  message_end: Hook<MessageEndHookInput, MessageEndHookResult>;
  /** 工具执行前:否决。 */
  tool_call: Hook<ToolCallHookInput, ToolCallHookResult>;
  /** 工具真正开始执行(未被否决)。 */
  tool_execution_start: Hook<ToolExecutionStartHookInput>;
  /** 工具执行中的增量输出。 */
  tool_execution_update: Hook<ToolExecutionUpdateHookInput>;
  /** 工具执行完毕(原始结果,tool_result 改写之前)。 */
  tool_execution_end: Hook<ToolExecutionEndHookInput>;
  /** 工具执行后、结果喂回模型前:改写。 */
  tool_result: Hook<ToolResultHookInput, ToolResultHookResult>;
  /** 压缩即将发生:可取消。 */
  session_before_compact: Hook<SessionBeforeCompactHookInput, SessionBeforeCompactHookResult>;
  /** 压缩已完成。 */
  session_compact: Hook<SessionCompactHookInput>;
  /** 模型切换。 */
  model_select: Hook<ModelSelectHookInput>;
  /** 思考档位切换。 */
  thinking_level_select: Hook<ThinkingLevelSelectHookInput>;
  /** 一轮开始(turn-start 之后)。 */
  turn_start: Hook<TurnStartHookInput>;
  /**
   * 一轮完全收尾之后(finally 已跑完、历史已落盘)。在这里 `agent.followUp()`
   * 排队的消息会作为下一轮开跑——这是 `/goal` 这类"评估后续跑"的正确挂点,
   * 见 loop.ts 的 run()。
   */
  turn_end: Hook<TurnEndHookInput>;
  /** 一次 run() 的整个链条(首轮 + 全部续跑)结束。 */
  agent_end: Hook<AgentEndHookInput>;
  /** agent_end 之后确认空闲(没有别的扩展在 agent_end 里又开了链条)。 */
  agent_settled: Hook<HookAgentInfo>;
  /** provider 应答之后。 */
  after_provider_response: Hook<AfterProviderResponseHookInput>;
  /** 即将切换会话:可取消。 */
  session_before_switch: Hook<SessionBeforeSwitchHookInput, SessionCancelHookResult>;
  /** 即将分叉会话:可取消。 */
  session_before_fork: Hook<undefined, SessionCancelHookResult>;
  /** 启动时收集扩展贡献的资源目录(技能)。 */
  resources_discover: Hook<undefined, ResourcesDiscoverHookResult>;
}

export type HookName = keyof HookMap;

export interface HookFailure {
  hook: HookName;
  error: Error;
}

type Handler<K extends HookName> = HookMap[K];

/** 通知型钩子(无返回值)。 */
type NotifyHook = {
  [K in HookName]: ReturnType<HookMap[K]> extends void | Promise<void> ? K : never;
}[HookName];

/** 可取消型钩子(返回 `{ cancel }`)。 */
type CancelableHook = {
  [K in HookName]: ReturnType<HookMap[K]> extends SessionCancelHookResult | Promise<SessionCancelHookResult>
    ? K
    : never;
}[HookName];

/**
 * 没有宿主时(单元测试直接 `new HookRegistry()`)给处理器的 ctx:一切都是
 * "没有 UI、空闲"的空实现。真会话由 bootstrap 注入。
 */
export function noopExtensionContext(): ExtensionContext {
  return {
    cwd: process.cwd(),
    hasUI: false,
    mode: 'print',
    isIdle: () => true,
    abort: () => {},
    waitForIdle: async () => {},
    newSession: async () => {},
    fork: async () => ({ id: '' }),
    switchSession: async () => {},
    model: () => ({}) as never,
    config: {} as never,
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      custom: async () => undefined,
      setWidget: () => {},
      setHeader: () => {},
      setFooter: () => {},
      setTitle: () => {},
      getEditorText: () => '',
      setEditorText: () => {},
      notify: () => {},
    },
  };
}

export class HookRegistry {
  /**
   * 每个钩子一张 `处理器 → 它的 ctx` 表。**用 Map 而不是 Set**:注册要按
   * 处理器身份去重(重复注册只算一次),同时每条注册要带自己的 ctx——
   * 扩展 A 的处理器该拿 A 的 ctx(A 的 ui 门面),bootstrap 曾为此在
   * `api.on` 里包一层匿名函数换 ctx,那既废掉了这里的去重(每次包出来的
   * 都是新函数),也在每个扩展的调用栈里塞一帧。
   */
  private readonly handlers = new Map<HookName, Map<Handler<HookName>, ExtensionContext | undefined>>();
  private readonly fallbackCtx: ExtensionContext;

  constructor(
    private readonly onError?: (failure: HookFailure) => void,
    fallbackCtx?: ExtensionContext,
  ) {
    this.fallbackCtx = fallbackCtx ?? noopExtensionContext();
  }

  /**
   * 注册;返回注销函数。同一处理器重复注册只算一次(后一次换掉它的 ctx)。
   * `ctx` 是这个处理器该收到的第二个参数;不给就用注册表的兜底。
   */
  on<K extends HookName>(name: K, handler: Handler<K>, ctx?: ExtensionContext): () => void {
    let table = this.handlers.get(name);
    if (!table) {
      table = new Map();
      this.handlers.set(name, table);
    }
    table.set(handler as Handler<HookName>, ctx);
    return () => {
      table.delete(handler as Handler<HookName>);
    };
  }

  /** 有没有人在听。loop 用它走零开销路径:没有工具钩子就不包装工具。 */
  has(name: HookName): boolean {
    return (this.handlers.get(name)?.size ?? 0) > 0;
  }

  /** 快照一份:处理器可能在被调用时注销自己,遍历活表会跳项。 */
  private list<K extends HookName>(name: K): Array<[Handler<K>, ExtensionContext]> {
    const table = this.handlers.get(name);
    if (!table) return [];
    return [...table].map(([handler, ctx]) => [handler as Handler<K>, ctx ?? this.fallbackCtx]);
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

  /**
   * 串行改写型钩子的公共引擎:逐个处理器跑,把返回值里的某一个字段接力
   * 下去,抛错保留当前值(fail open,见文件头)。tool_result / context /
   * message_end / before_provider_request 的循环体曾经逐字相同,只差字段名。
   */
  private async reduceField<K extends HookName, V>(
    name: K,
    input: Parameters<Handler<K>>[0],
    field: string,
    initial: V,
  ): Promise<V> {
    let value = initial;
    for (const [handler, ctx] of this.list(name)) {
      try {
        const fire = handler as (i: unknown, c: ExtensionContext) => unknown;
        const result = (await fire({ ...input, [field]: value }, ctx)) as Record<string, V> | undefined;
        if (result && result[field] !== undefined) value = result[field]!;
      } catch (err) {
        this.report(name, err);
      }
    }
    return value;
  }

  /**
   * 通知型钩子:逐个 await,异常各自上报,不影响后面的处理器。**公开**是
   * 有意的——它加上 `cancelable` / `reduceField` 就是这个类的全部引擎,
   * 十几个「一行转发一次」的具名包装只是噪音,调用方直接写钩子名即可
   * (`NotifyHook` 保证只有真的没有返回值的钩子能走这条路)。
   */
  async notify<K extends NotifyHook>(name: K, input: Parameters<Handler<K>>[0]): Promise<void> {
    if (!this.has(name)) return;
    for (const [handler, ctx] of this.list(name)) {
      try {
        await (handler as (i: Parameters<Handler<K>>[0], c: ExtensionContext) => void | Promise<void>)(
          input,
          ctx,
        );
      } catch (err) {
        this.report(name, err);
      }
    }
  }

  /** 任一处理器 cancel 即取消;抛错视同不取消。 */
  async cancelable<K extends CancelableHook>(
    name: K,
    input: Parameters<Handler<K>>[0],
  ): Promise<{ cancel: boolean }> {
    for (const [handler, ctx] of this.list(name)) {
      try {
        const result = await (
          handler as (
            i: Parameters<Handler<K>>[0],
            c: ExtensionContext,
          ) => SessionCancelHookResult | Promise<SessionCancelHookResult>
        )(input, ctx);
        if (result?.cancel) return { cancel: true };
      } catch (err) {
        this.report(name, err);
      }
    }
    return { cancel: false };
  }

  /** 第一个否决即返回;处理器抛错视同否决(见文件头的失败策略)。 */
  async toolCall(input: ToolCallHookInput): Promise<{ block: true; reason: string } | undefined> {
    for (const [handler, ctx] of this.list('tool_call')) {
      try {
        const result = await handler(input, ctx);
        if (result?.block) return result;
      } catch (err) {
        const error = this.report('tool_call', err);
        return { block: true, reason: `Tool call blocked: a tool_call hook failed (${error.message}).` };
      }
    }
    return undefined;
  }

  /** 串行改写,返回最终的 output;处理器抛错保留当前值。 */
  toolResult(input: ToolResultHookInput): Promise<unknown> {
    return this.reduceField('tool_result', input, 'output', input.output);
  }

  /** 串行改写这次要发出去的消息。 */
  context(input: ContextHookInput): Promise<ModelMessage[]> {
    return this.reduceField('context', input, 'messages', input.messages);
  }

  /** 串行改写一条定稿消息。 */
  messageEnd(input: MessageEndHookInput): Promise<ModelMessage> {
    return this.reduceField('message_end', input, 'message', input.message);
  }

  /** 串行改写请求参数。 */
  beforeProviderRequest(input: BeforeProviderRequestHookInput): Promise<ProviderRequestParams> {
    return this.reduceField('before_provider_request', input, 'params', input.params);
  }

  /**
   * 串行改写,返回最终的系统提示词与要注入的消息(按处理器顺序);处理器
   * 抛错保留当前值。两个产物,不走 reduceField。
   */
  async beforeAgentStart(
    input: BeforeAgentStartHookInput,
  ): Promise<{ systemPrompt: string; messages: string[] }> {
    let systemPrompt = input.systemPrompt;
    const messages: string[] = [];
    for (const [handler, ctx] of this.list('before_agent_start')) {
      try {
        const result = await handler({ ...input, systemPrompt }, ctx);
        if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
        if (result?.message) messages.push(result.message);
      } catch (err) {
        this.report('before_agent_start', err);
      }
    }
    return { systemPrompt, messages };
  }

  /** 串行:transform 换掉文本继续;handled 立即返回;抛错的处理器当 continue。 */
  async input(
    input: InputHookInput,
  ): Promise<{ handled: true } | { handled: false; text: string; images?: ImageAttachment[] }> {
    let text = input.text;
    let images = input.images;
    for (const [handler, ctx] of this.list('input')) {
      try {
        const result = await handler({ ...input, text, images }, ctx);
        if (!result) continue;
        if (result.action === 'handled') return { handled: true };
        if (result.action === 'transform') {
          text = result.text;
          images = result.images;
        }
      } catch (err) {
        this.report('input', err);
      }
    }
    return { handled: false, text, images };
  }

  /** 收集全部处理器贡献的技能目录;抛错的跳过。 */
  async resourcesDiscover(): Promise<{ skillPaths: string[] }> {
    const skillPaths: string[] = [];
    for (const [handler, ctx] of this.list('resources_discover')) {
      try {
        const result = await handler(undefined, ctx);
        if (result?.skillPaths) skillPaths.push(...result.skillPaths);
      } catch (err) {
        this.report('resources_discover', err);
      }
    }
    return { skillPaths };
  }
}
