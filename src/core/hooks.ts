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
import {
  extensionTheme,
  isPiToolResult,
  piContentText,
  toPiContent,
  type PiContentPart,
  type SendMessageInput,
} from './extension-types.js';

/** 每个钩子输入都带的调用方信息。 */
export interface HookAgentInfo {
  /**
   * 这次调用来自子 agent(task 工具 / fork 技能)。权限措辞、要不要弹确认、
   * 轮后要不要续跑,扩展都得看它——子 agent 的轮不是用户的轮。
   */
  subagent: boolean;
}

/**
 * 字段名以 **Pi 的为准**:`toolCallId` / `args` / `result` / `partialResult` /
 * `prompt`。这里原有的同义字段(`callId`、工具执行钩子里的 `input` / `output`、
 * `chunk`、before_agent_start 的 `userText`)只是改了名的旧叫法,标了
 * `@deprecated`、仍然填着值,给已有的扩展一段迁移期,之后删掉——同一个值
 * 长期挂两个名字,作者只会困惑该用哪个。旧叫法**只由注册表在派发时补**
 * (`DEPRECATED_ALIASES`),生产方只填 Pi 的名字;移除时删那张表与这些字段。
 *
 * **不是同义词的不在此列**:`tool_call` / `tool_result` 的 `input` 与 Pi 同名
 * (Pi 自己在这两个钩子里就叫 `input`,到 tool_execution_* 才叫 `args`);
 * `tool_result` 的 `output` 是工具的原始结构化返回,Pi 没有对应(它只有
 * `content` / `details`),LSP 扩展正是读它。
 */
export interface ToolCallHookInput extends HookAgentInfo {
  toolCallId: string;
  /** @deprecated 用 `toolCallId`(Pi 的字段名)。0.x 期间还带着,将在后续版本移除。 */
  callId: string;
  toolName: string;
  input: unknown;
}

/** 返回 block 即否决:工具不执行,reason 作为工具错误喂回模型(保持英文)。 */
export type ToolCallHookResult = { block: true; reason: string } | undefined | void;

export interface ToolResultHookInput extends HookAgentInfo {
  toolCallId: string;
  /** @deprecated 用 `toolCallId`(Pi 的字段名)。0.x 期间还带着,将在后续版本移除。 */
  callId: string;
  toolName: string;
  input: unknown;
  /** 工具的返回值;isError 时是错误消息字符串。多个处理器串行时看到的是前一个改写后的值。 */
  output: unknown;
  /** 同一个结果的 Pi 视图:模型看到的内容部件(非 Pi 形状的输出转成一段文本)。 */
  content: PiContentPart[];
  /** Pi 形状工具结果的 `details`(只给画法);其余工具为 undefined。 */
  details: unknown;
  isError: boolean;
}

/**
 * 两种改写写法,任选其一:
 * - `{ output }`:整个换掉工具的返回值(isError 时换的是错误消息);
 * - Pi 的 `{ content, details, isError }`:`content` 换掉模型看到的内容,
 *   `details` 换掉给画法的数据(只对 Pi 形状的工具有意义),`isError` 把成功
 *   改判成错误或反过来。
 * 同时给了 `output` 就以它为准。
 */
export type ToolResultHookResult =
  | { output?: unknown; content?: PiContentPart[]; details?: unknown; isError?: boolean }
  | undefined
  | void;

/** 工具真正开始执行(tool_call 没否决之后)。 */
export interface ToolExecutionStartHookInput extends HookAgentInfo {
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** @deprecated 用 `toolCallId`(Pi 的字段名)。0.x 期间还带着,将在后续版本移除。 */
  callId: string;
  /** @deprecated 用 `args`(Pi 的字段名)。0.x 期间还带着,将在后续版本移除。 */
  input: unknown;
}

/** 工具执行中的增量输出(目前只有 bash 发;子 agent 的不经主总线,收不到)。 */
export interface ToolExecutionUpdateHookInput extends HookAgentInfo {
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: string;
  /** @deprecated 用 `toolCallId`(Pi 的字段名)。0.x 期间还带着,将在后续版本移除。 */
  callId: string;
  /** @deprecated 用 `partialResult`(Pi 的字段名)。0.x 期间还带着,将在后续版本移除。 */
  chunk: string;
}

/** 工具执行完毕(tool_result 改写**之前**的原始结果)。 */
export interface ToolExecutionEndHookInput extends HookAgentInfo {
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** 原始结果(tool_result 改写之前);错误时是错误消息。 */
  result: unknown;
  isError: boolean;
  durationMs: number;
  /** @deprecated 用 `toolCallId`(Pi 的字段名)。0.x 期间还带着,将在后续版本移除。 */
  callId: string;
  /** @deprecated 用 `args`(Pi 的字段名)。0.x 期间还带着,将在后续版本移除。 */
  input: unknown;
  /** @deprecated 用 `result`(Pi 的字段名)。0.x 期间还带着,将在后续版本移除。 */
  output: unknown;
}

export interface BeforeAgentStartHookInput extends HookAgentInfo {
  /** 核心组装好的系统提示词;多个处理器串行,各自看到前一个的产物。 */
  systemPrompt: string;
  /** 本轮的用户文本(引导续跑的流没有,为 undefined)。 */
  prompt?: string;
  /** @deprecated 用 `prompt`(Pi 的字段名)。0.x 期间还带着,将在后续版本移除。 */
  userText?: string;
}

/**
 * before_agent_start 注入的一条消息:纯文本,或 Pi 的自定义消息形状(以
 * `customType` 的信封进历史,时间线按 registerMessageRenderer 画;`display:
 * false` 不上时间线)。
 */
export type BeforeAgentStartMessage = string | SendMessageInput;

/**
 * `systemPrompt` 改写发出去的系统提示词;`message` 以一条 user 消息进入本轮
 * 上下文(与 Pi 的 `message` 同义,只在本轮首个流生效——引导续跑再开的流
 * 不重复注入),它会进持久历史。
 */
export type BeforeAgentStartHookResult =
  | { systemPrompt?: string; message?: BeforeAgentStartMessage }
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
 * 一条 assistant 消息开始流出(Pi 的 `message_start`):每个 step 一条。
 * `message` 是此刻的部分消息(content 为空),流式监听的扩展在这里开始记账。
 */
export interface MessageStartHookInput extends HookAgentInfo {
  message: ModelMessage;
}

/**
 * assistant 消息的流式增量(Pi 的 `message_update`):`message` 是累积到此刻
 * 的部分消息(text / reasoning 部件按 id 就地追加),`delta` 是这一份增量。
 * 只在有人监听时才组装与触发,不监听零开销。
 */
export interface MessageUpdateHookInput extends HookAgentInfo {
  message: ModelMessage;
  delta: { type: 'text' | 'reasoning'; id: string; text: string };
}

/**
 * 用户在输入框敲 `!<command>`(Pi 的 `user_bash`):命令执行前给扩展一次机会。
 * 返回 `command` 改写要跑的命令;返回 `run` 接管执行(在容器里跑、走远程
 * 主机之类),第一个给出 `run` 的处理器赢。输出并入历史,不开轮。
 */
export interface UserBashHookInput {
  command: string;
  cwd: string;
}

export type UserBashRunner = (input: {
  command: string;
  cwd: string;
  signal: AbortSignal;
}) => Promise<{ exitCode: number; output: string }>;

export type UserBashHookResult = { command?: string; run?: UserBashRunner } | undefined | void;

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
  /** 切换前的 provider 与模型 id(Pi 的 `previousModel`;这里是 id 字符串,不是模型对象)。 */
  previousProvider: string;
  previousModel: string;
  /** 与 Pi 同名;这里的模型切换都是显式设置,恒为 `set`(恢复会话不换模型)。 */
  source: 'set';
}

/** 思考档位变了(`/think`、扩展的 setThinkingLevel)。 */
export interface ThinkingLevelSelectHookInput {
  level: string;
  previousLevel: string;
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

/**
 * 即将换会话(Pi 的 `session_before_switch`):`new` 是 `/new` 与扩展的
 * newSession,`resume` 是 `/resume` 与扩展的 switchSession。
 */
export interface SessionBeforeSwitchHookInput {
  reason: 'new' | 'resume';
  /** 目标会话 id(resume 时,已解析过前缀);new 时没有。 */
  id?: string;
  /** 目标会话文件的绝对路径(Pi 的字段名);new 时没有。 */
  targetSessionFile?: string;
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

/** 切换到了另一个会话(`/resume`、扩展的 switchSession)之后,Pi 的 `session_switch`。 */
export interface SessionSwitchHookInput {
  id: string;
}

/** 分叉出了新会话(`/fork`、扩展的 fork)之后,Pi 的 `session_fork`。 */
export interface SessionForkHookInput {
  id: string;
}

/**
 * 扩展贡献资源目录(Pi 的 resources_discover):技能目录、提示词模板目录
 * (`*.md`,每个文件一条 `/name` 命令)、主题目录(`*.json`)。相对工作区根。
 * 启动时问一遍全部扩展,每次 `/reload` 之后再问一遍全部(`reason: 'reload'`,
 * 结果整体替换上一次的)——它是纯查询,没被重载的扩展再答一次无害。
 */
export interface ResourcesDiscoverHookInput {
  cwd: string;
  reason: 'startup' | 'reload';
}

export type ResourcesDiscoverHookResult =
  | { skillPaths?: string[]; promptPaths?: string[]; themePaths?: string[] }
  | undefined
  | void;

/**
 * 会话就位的原因。扩展在这里从会话记录恢复自己的状态(`entries(type)` 读的
 * 已经是新会话的记录):startup 是进程启动(含 `-c`/`-r` 恢复),`new` /
 * `resume` / `fork` 是 TUI 内的 `/new`、`/resume`、`/fork`,`reload` 只发给
 * `/reload` 重新装上的扩展——它们没赶上启动那一次,不在这里补一次就恢复不了
 * 自己的状态。
 */
export type SessionStartReason = 'startup' | 'new' | 'resume' | 'fork' | 'reload';

export interface SessionStartHookInput {
  reason: SessionStartReason;
  /** 换会话之前那个会话文件的绝对路径(Pi 的字段名);startup / reload 没有。 */
  previousSessionFile?: string;
}

/**
 * 会话关闭(Pi 的 `session_shutdown`)。这里只有两种:`quit` 是进程退出,
 * `reload` 是 `/reload` 卸载这个扩展。换会话(`/new`、`/resume`、`/fork`)
 * **不**发——扩展的运行时跨会话活着(MCP 连接、LSP 进程不随会话重建),
 * 与 Pi 每换一次会话重建整个运行时不同。
 */
export interface SessionShutdownHookInput {
  reason: 'quit' | 'reload';
}

/** 处理器统一的形状:输入 + 上下文。 */
type Hook<I, R = void> = (input: I, ctx: ExtensionContext) => R | Promise<R>;

export interface HookMap {
  /** 会话就位(启动、/new、/resume、/fork 之后,历史与状态已换好)。 */
  session_start: Hook<SessionStartHookInput>;
  /** 会话关闭(进程退出,或 /reload 卸载这个扩展)。 */
  session_shutdown: Hook<SessionShutdownHookInput>;
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
  /** 一条 assistant 消息开始流出(每个 step 一条)。 */
  message_start: Hook<MessageStartHookInput>;
  /** assistant 消息的流式增量(累积的部分消息 + 这一份增量)。 */
  message_update: Hook<MessageUpdateHookInput>;
  /** 一条模型侧消息定稿、并入历史之前。 */
  message_end: Hook<MessageEndHookInput, MessageEndHookResult>;
  /** 用户敲 `!command`:改写命令或接管执行。 */
  user_bash: Hook<UserBashHookInput, UserBashHookResult>;
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
  /** 已切到另一个会话(`session_start` reason=resume 之后)。 */
  session_switch: Hook<SessionSwitchHookInput>;
  /** 已分叉出新会话(`session_start` reason=fork 之后)。 */
  session_fork: Hook<SessionForkHookInput>;
  /** 启动时收集扩展贡献的资源目录(技能)。 */
  resources_discover: Hook<ResourcesDiscoverHookInput, ResourcesDiscoverHookResult>;
}

export type HookName = keyof HookMap;

export interface HookFailure {
  hook: HookName;
  error: Error;
}

type Handler<K extends HookName> = HookMap[K];

/**
 * 迁移期的旧叫法 → Pi 的字段名(见 ToolCallHookInput 上方的说明)。注册表在
 * 派发时照这张表补上旧字段,生产方与类型检查都只认 Pi 的名字。
 */
const DEPRECATED_ALIASES = {
  tool_call: { callId: 'toolCallId' },
  tool_result: { callId: 'toolCallId' },
  tool_execution_start: { callId: 'toolCallId', input: 'args' },
  tool_execution_update: { callId: 'toolCallId', chunk: 'partialResult' },
  tool_execution_end: { callId: 'toolCallId', input: 'args', output: 'result' },
  before_agent_start: { userText: 'prompt' },
} as const satisfies Partial<Record<HookName, Record<string, string>>>;
type Aliased = typeof DEPRECATED_ALIASES;

/** 生产方交给注册表的输入:不含旧叫法(那些由注册表补)。 */
export type HookInput<K extends HookName> = K extends keyof Aliased
  ? Omit<Parameters<Handler<K>>[0], keyof Aliased[K]>
  : Parameters<Handler<K>>[0];

function withAliases<K extends HookName>(name: K, input: HookInput<K>): Parameters<Handler<K>>[0] {
  const aliases = (DEPRECATED_ALIASES as Partial<Record<HookName, Record<string, string>>>)[name];
  if (!aliases) return input as Parameters<Handler<K>>[0];
  const out: Record<string, unknown> = { ...input };
  for (const [old, current] of Object.entries(aliases)) out[old] = out[current];
  return out as unknown as Parameters<Handler<K>>[0];
}

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
    signal: undefined,
    hasPendingMessages: () => false,
    shutdown: () => {},
    getSystemPrompt: () => '',
    getContextUsage: () => ({ used: 0, window: 0, percent: 0 }),
    compact: async () => {},
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false, id: '' }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => {},
    sendMessage: async () => {},
    sendUserMessage: async () => {},
    model: () => ({}) as never,
    config: {} as never,
    sessionManager: {
      getSessionId: () => '',
      getSessionName: () => '',
      getEntries: () => [],
      getHistory: () => [],
      getDisplayHistory: () => [],
      listSessions: async () => [],
    },
    modelRegistry: {
      getCurrent: () => ({ provider: '', model: '' }),
      getProviders: () => [],
      getModels: () => [],
      find: () => undefined,
      capabilities: async () => undefined,
      probe: async () => [],
    },
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      editor: async () => undefined,
      custom: async () => undefined,
      setWidget: () => {},
      setHeader: () => {},
      setFooter: () => {},
      setTitle: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      theme: extensionTheme,
      getAllThemes: async () => [],
      getTheme: async () => undefined,
      setTheme: async () => ({ success: false, error: 'no host' }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
      onTerminalInput: () => () => {},
      getEditorText: () => '',
      setEditorText: () => {},
      pasteToEditor: () => {},
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

  /**
   * 此刻注册在 name 上的处理器(按身份)。`/reload` 在重新装载前拍一份,装完
   * 用 `notify(…, except)` 只通知新装上的扩展——一方扩展没被重载,再发一次
   * `session_start` 会让它们把状态恢复第二遍。
   */
  snapshot(name: HookName): ReadonlySet<unknown> {
    return new Set(this.handlers.get(name)?.keys() ?? []);
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
  async notify<K extends NotifyHook>(
    name: K,
    input: HookInput<K>,
    /** 跳过这些处理器(`/reload` 只通知重新装上的扩展,见 snapshot)。 */
    except?: ReadonlySet<unknown>,
  ): Promise<void> {
    if (!this.has(name)) return;
    const payload = withAliases(name, input);
    for (const [handler, ctx] of this.list(name)) {
      if (except?.has(handler)) continue;
      try {
        await (handler as (i: Parameters<Handler<K>>[0], c: ExtensionContext) => void | Promise<void>)(
          payload,
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
  async toolCall(input: HookInput<'tool_call'>): Promise<{ block: true; reason: string } | undefined> {
    const payload = withAliases('tool_call', input);
    for (const [handler, ctx] of this.list('tool_call')) {
      try {
        const result = await handler(payload, ctx);
        if (result?.block) return result;
      } catch (err) {
        const error = this.report('tool_call', err);
        return { block: true, reason: `Tool call blocked: a tool_call hook failed (${error.message}).` };
      }
    }
    return undefined;
  }

  /**
   * 串行改写,返回最终的结果与错误判定;处理器抛错保留当前值。每个处理器看到
   * 的 `content` / `details` 都按**当前**值现算(两套字段指向同一份结果)。
   *
   * Pi 形状的返回(`content` / `details` / `isError`)落到这里的输出上:Pi 形状
   * 工具的结果就地换掉那两个字段(details 还要留给画法);其余工具的输出本来
   * 就是一个值,换 `content` 等于把模型看到的内容换成那段文本。
   */
  async toolResult(
    input: Omit<HookInput<'tool_result'>, 'content' | 'details'>,
  ): Promise<{ output: unknown; isError: boolean }> {
    const base = withAliases('tool_result', input as HookInput<'tool_result'>);
    let output = input.output;
    let isError = input.isError;
    for (const [handler, ctx] of this.list('tool_result')) {
      try {
        // content / details 是**按需**算的:toPiContent 要把非 Pi 形状的输出整个
        // JSON 化(工具输出能到 20k 字),而常见的处理器(LSP)只读 output——每次
        // 工具调用、每个处理器都白算一遍不值。getter 不会被展开钉死:view 直接
        // 交给处理器,处理器解构到哪个字段才算哪个。
        const current = output;
        const view = Object.defineProperties(
          { ...base, output: current, isError } as ToolResultHookInput,
          {
            content: { enumerable: true, get: () => toPiContent(current) },
            details: { enumerable: true, get: () => (isPiToolResult(current) ? current.details : undefined) },
          },
        );
        const result = await handler(view, ctx);
        if (!result) continue;
        if (result.output !== undefined) {
          output = result.output;
        } else if (result.content !== undefined || result.details !== undefined) {
          if (isPiToolResult(output)) {
            output = {
              ...output,
              ...(result.content !== undefined ? { content: result.content } : {}),
              ...(result.details !== undefined ? { details: result.details } : {}),
            };
          } else if (result.content !== undefined) {
            output = piContentText(result.content);
          }
        }
        if (result.isError !== undefined) isError = result.isError;
      } catch (err) {
        this.report('tool_result', err);
      }
    }
    return { output, isError };
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
    input: HookInput<'before_agent_start'>,
  ): Promise<{ systemPrompt: string; messages: BeforeAgentStartMessage[] }> {
    const base = withAliases('before_agent_start', input);
    let systemPrompt = input.systemPrompt;
    const messages: BeforeAgentStartMessage[] = [];
    for (const [handler, ctx] of this.list('before_agent_start')) {
      try {
        const result = await handler({ ...base, systemPrompt }, ctx);
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

  /** 收集全部处理器贡献的资源目录(技能 / 提示词模板 / 主题);抛错的跳过。 */
  async resourcesDiscover(
    input: ResourcesDiscoverHookInput,
  ): Promise<{ skillPaths: string[]; promptPaths: string[]; themePaths: string[] }> {
    const skillPaths: string[] = [];
    const promptPaths: string[] = [];
    const themePaths: string[] = [];
    for (const [handler, ctx] of this.list('resources_discover')) {
      try {
        const result = await handler(input, ctx);
        if (result?.skillPaths) skillPaths.push(...result.skillPaths);
        if (result?.promptPaths) promptPaths.push(...result.promptPaths);
        if (result?.themePaths) themePaths.push(...result.themePaths);
      } catch (err) {
        this.report('resources_discover', err);
      }
    }
    return { skillPaths, promptPaths, themePaths };
  }

  /**
   * `!command` 执行前:串行,`command` 接力改写,第一个给出 `run` 的处理器
   * 接管执行(后面的处理器仍看得到改写后的命令,但它们的 run 不再采纳)。
   * 抛错的处理器当没说话。
   */
  async userBash(input: UserBashHookInput): Promise<{ command: string; run?: UserBashRunner }> {
    let command = input.command;
    let run: UserBashRunner | undefined;
    for (const [handler, ctx] of this.list('user_bash')) {
      try {
        const result = await handler({ ...input, command }, ctx);
        if (!result) continue;
        if (result.command !== undefined) command = result.command;
        if (result.run && !run) run = result.run;
      } catch (err) {
        this.report('user_bash', err);
      }
    }
    return { command, run };
  }
}
