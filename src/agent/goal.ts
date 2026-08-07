/**
 * `/goal`:给定一个完成条件,每轮结束后由评估器判断是否达成,没达成就把
 * 评估理由当作下一轮的指令自动续跑,直到达成或触到安全边界。
 *
 * 这里属于 agent 核心,不认识 UI 框架:一切对外表达都走 EventBus 的 goal-*
 * 事件,TUI 与 headless 各自决定怎么呈现。
 *
 * **为什么循环由这里持有,而不是订阅 bus 的 turn-end**——那样做会静悄悄地
 * 写坏历史:turn-end 在 `Agent.run()` 的 try 里就发出了(loop.ts:283),此刻
 * finally 还没跑、controller 还在,于是处理器里调 `agent.run()` 会被重入
 * 兜底(loop.ts:244)转成 inject 塞进 pendingGuidance 立即返回;控制权回到
 * 原来那轮的 finally,它把 pendingGuidance 一并并进持久历史(loop.ts:299)。
 * 结果是:一条模型从没看过的引导进了历史,第二轮压根没起,下一轮真实对话
 * 却要面对一条过期的指令。这里只在 `await agent.run(...)` 兑现之后(也就是
 * finally 跑完、controller 已清)才发起下一轮。
 */

import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import type { ImageAttachment } from '../app/attachments.js';
import type { Config } from '../config/schema.js';
import type { EventBus, GoalStopReason } from '../core/events.js';
import type { Agent } from './loop.js';

/** `/goal` 的运行时状态。只有 condition 进会话记录,其余都是本次监管的统计。 */
export interface GoalState {
  /** 用户写下的条件原文,也是第一轮的指令。 */
  condition: string;
  /** 本次监管的起点。恢复来的目标在真正开跑时重置。 */
  startedAt: number;
  /** 已跑完的轮数,含用户发起的第一轮。 */
  turns: number;
  /** 评估器最近一次的判词。`/goal` 展示它,也是下一轮指令的来源。 */
  lastReason: string;
  /** 开始监管那一刻 agent 的累计 token,用来算"本目标花了多少"。 */
  tokenBaseline: number;
  /** 评估器自身的消耗:它走的是另一个模型,不进 agent 的累计。 */
  evaluatorTokens: number;
  /** 从会话记录恢复而来、还没跑过任何一轮。恢复不自动开跑,见 restore()。 */
  restored: boolean;
}

/** `/goal` 无参展示状态时要的一份即时快照。 */
export interface GoalStatus {
  condition: string;
  turns: number;
  maxTurns: number;
  elapsedMs: number;
  tokens: number;
  lastReason: string;
  restored: boolean;
}

export interface GoalControllerOptions {
  /**
   * 只用这两样:发起一轮、读历史给评估器。写成 Pick 是把依赖面钉死在类型
   * 里——测试注一个两字段的假对象就够了。
   */
  agent: Pick<Agent, 'run' | 'history'>;
  bus: EventBus;
  /** 按引用持有:goalMaxTurns 改了立刻生效。 */
  config: Config;
  /**
   * 每次评估现取模型:`/model`、`/provider` 换过之后 provider 是个新对象,
   * 提前建好的模型会一直打向已经被换掉的那个服务端。
   */
  evaluatorModel: () => LanguageModel;
  /** 目标本身变化(设定/恢复/清除)时通知宿主落盘。轮数变化不触发。 */
  onChange?: () => void;
}

/** 评估器看到的历史条数,以及每条、总共保留的字符数。 */
const TAIL_MESSAGES = 14;
const MESSAGE_CHARS = 800;
const TOTAL_CHARS = 12_000;
/** 连续这么多次判不出结果就停手,免得评估器坏掉时空转烧 token。 */
const MAX_PARSE_FAILURES = 2;

interface Directive {
  text: string;
  images?: ImageAttachment[];
  display?: string;
}

export class GoalController {
  private goal: GoalState | undefined;
  /** 监管循环进行中(**含两轮之间的评估窗口**)。 */
  private supervising = false;
  /**
   * 目标的代数。set/restore/clear 都会递增,循环在每个 await 之后比对:
   * 跨代即作废——否则 `/new` 或 `/goal clear` 之后循环还会接着往一段已经
   * 不存在的对话里灌轮次。
   */
  private generation = 0;
  /** 上一轮是否正常收尾。见 run() 里的解释。 */
  private turnEnded = false;
  private sawAbort = false;
  /** 最近一次 usage 事件报出的会话累计 token。 */
  private cumulative = 0;
  private parseFailures = 0;
  /** 评估窗口里用户发来的消息,取代评估器的引导作为下一轮指令。 */
  private pending: Directive | undefined;
  /**
   * 进行中的那次评估调用。停止目标时必须把它掐掉:光靠代数作废的话,请求
   * 还在飞,`supervising` 就一直是真——命令被 busy 拦着、esc 又被 goal.busy
   * 这一支吃掉,碰上一个卡住的 goalModel 端点就只剩 ctrl+c 能救。
   */
  private evaluation: AbortController | undefined;
  private readonly off: () => void;

  constructor(private readonly options: GoalControllerOptions) {
    this.off = options.bus.on((event) => {
      if (event.type === 'turn-end') {
        // turn-end 只在整轮正常收尾时发(loop.ts:283 的 `if (finish)`),
        // 中断与致命错误都走不到。这就是"这一轮到底跑成没有"最精确的信号,
        // 比听 error 事件可靠得多——后者连一次可恢复的流内错误也会发。
        this.turnEnded = true;
        this.observeSpend(event.usage.cumulativeTotalTokens);
      } else if (event.type === 'step-end') {
        this.observeSpend(event.usage.cumulativeTotalTokens);
      } else if (event.type === 'aborted') {
        this.sawAbort = true;
      } else if (event.type === 'permission-change' && event.plan) {
        // 计划模式的要义就是停下来等批准,与自动续跑正相反;而且 exit_plan
        // 获批会在循环中途改掉权限(bootstrap.ts:150),那是一次无人看管的
        // 提权。shift+tab 或 /plan 切进来时就地解除,不留下暗桩。
        this.clear('plan-mode');
      }
    });
  }

  get state(): Readonly<GoalState> | undefined {
    return this.goal;
  }

  get active(): boolean {
    return this.goal !== undefined;
  }

  /**
   * 监管循环进行中——**包括两轮之间的评估窗口**,那段时间 agent.isRunning
   * 为 false。UI 的"忙"判断必须并上它,否则评估窗口里 esc 会去武装回退
   * 选择器、`/clear` 会绕过拦截把会话换掉。
   */
  get busy(): boolean {
    return this.supervising;
  }

  /** 设定(或替换)目标。不发起轮次,由随后的 run() 开跑。 */
  set(condition: string): void {
    if (this.goal) this.stop('replaced');
    this.goal = {
      condition,
      startedAt: Date.now(),
      turns: 0,
      lastReason: '',
      tokenBaseline: this.cumulative,
      evaluatorTokens: 0,
      restored: false,
    };
    this.generation++;
    this.parseFailures = 0;
    this.options.onChange?.();
    this.options.bus.emit({ type: 'goal-start', condition, restored: false });
  }

  /**
   * 从会话记录恢复:已设定,但 `restored` 为真——不自动开跑,等用户下一条
   * 消息才开始监管。打开一个旧会话就凭空烧掉一轮 token 是不可接受的。
   * 计时、轮数、token 基线都在真正开跑时重置。
   */
  restore(condition: string): void {
    // 从一个带目标的会话 /resume 到另一个带目标的会话:旧目标也得有交代,
    // 否则用户只看见"已恢复 B",永远不知道 A 被丢了(events.ts 里说好了
    // 每条离开目标的路径都要报一个停止原因)。
    if (this.goal) this.stop('replaced');
    this.goal = {
      condition,
      startedAt: Date.now(),
      turns: 0,
      lastReason: '',
      tokenBaseline: this.cumulative,
      evaluatorTokens: 0,
      restored: true,
    };
    this.generation++;
    this.parseFailures = 0;
    this.options.bus.emit({ type: 'goal-start', condition, restored: true });
  }

  /** 取消目标。循环在下一个 await 点自行退出;进行中的那一轮不打断。 */
  clear(reason: GoalStopReason = 'cleared'): void {
    this.stop(reason);
  }

  /** `/goal` 无参展示状态用。 */
  snapshot(): GoalStatus | undefined {
    const goal = this.goal;
    if (!goal) return undefined;
    return {
      condition: goal.condition,
      turns: goal.turns,
      maxTurns: this.options.config.goalMaxTurns,
      elapsedMs: Date.now() - goal.startedAt,
      tokens: this.spend(goal),
      lastReason: goal.lastReason,
      restored: goal.restored,
    };
  }

  /**
   * 评估窗口里接住用户消息:作为下一轮的指令,取代评估器的引导。
   * 不在窗口里返回 false,调用方按原路径处理。
   *
   * 少了这一步就是本功能最糟的失败模式:窗口里 agent 是空闲的,`inject`
   * 落空,调用方另起一轮;循环随后发起的那一轮撞上 isRunning 退化成
   * inject 立即返回,于是循环把它当成"一轮 0 毫秒就跑完了",一边流式
   * 输出一边空转评估。
   */
  steer(
    text: string,
    options?: { display?: string; images?: ImageAttachment[] },
  ): boolean {
    if (!this.supervising) return false;
    // display 必须一路带到发起那一轮:这条消息最终是经 agent.run 发出的,会
    // 发 turn-start,时间线照 `display ?? userText` 回显。不带的话,`@文件`
    // 展开后的全文会整个糊在时间线上(inject 那条路不会,它压根不发 turn-start)。
    const display = options?.display;
    // 窗口里连发多条:合并,一条都不能丢。缺 display 的那半用它的原文补上,
    // 否则合并后半条展开、半条原文。
    this.pending = this.pending
      ? {
          text: `${this.pending.text}\n\n${text}`,
          ...(this.pending.display ?? display
            ? {
                display: `${this.pending.display ?? this.pending.text}\n\n${display ?? text}`,
              }
            : {}),
          ...mergeImages(this.pending.images, options?.images),
        }
      : {
          text,
          ...(display ? { display } : {}),
          ...(options?.images?.length ? { images: options.images } : {}),
        };
    return true;
  }

  /**
   * 发起一轮。目标未激活时等价于 `agent.run`;激活时接管后续:评估 →
   * 未达成则以评估理由为指令续跑 → 再评估,直到达成或触到边界。
   * 与 `agent.run` 一样不会 reject。
   */
  async run(
    text: string,
    options?: { display?: string; images?: ImageAttachment[] },
  ): Promise<void> {
    if (!this.goal) return this.options.agent.run(text, options);
    // 兜底:正常路径上 App 会先问过 steer,不该走到这里。
    if (this.supervising) {
      this.steer(text, options);
      return;
    }

    // 在任何 await 之前置位,busy 立刻为真。
    this.supervising = true;
    const gen = this.generation;
    const goal = this.goal;
    if (goal.restored) {
      goal.startedAt = Date.now();
      goal.turns = 0;
      goal.tokenBaseline = this.cumulative;
      goal.evaluatorTokens = 0;
      goal.restored = false;
    }
    this.parseFailures = 0;

    try {
      let directive: Directive = {
        text,
        ...(options?.images?.length ? { images: options.images } : {}),
        ...(options?.display ? { display: options.display } : {}),
      };

      for (;;) {
        this.turnEnded = false;
        this.sawAbort = false;
        await this.options.agent.run(directive.text, runOptions(directive));
        if (gen !== this.generation || !this.goal) return;
        this.goal.turns += 1;

        // 没有 turn-end:这一轮被 esc 掐了,或以致命错误收尾。两种情况都
        // 不能续跑——对着一个 401 或被中断的会话一轮接一轮地重试毫无意义。
        if (!this.turnEnded) {
          this.stop(this.sawAbort ? 'aborted' : 'error');
          return;
        }

        // 用户在评估之前就发了话:他的指令优先,这一轮不必评估。
        const steered = this.takePending();
        if (steered) {
          directive = steered;
          continue;
        }

        this.options.bus.emit({ type: 'goal-evaluating', turn: this.goal.turns });
        const verdict = await this.evaluate(this.goal.condition);
        if (gen !== this.generation || !this.goal) return;

        if (!verdict) {
          this.parseFailures += 1;
          if (this.parseFailures >= MAX_PARSE_FAILURES) {
            this.stop('check-failed');
            return;
          }
        } else {
          this.parseFailures = 0;
          this.goal.lastReason = verdict.reason;
          this.options.bus.emit({
            type: 'goal-verdict',
            met: verdict.met,
            reason: verdict.reason,
            turn: this.goal.turns,
            maxTurns: this.options.config.goalMaxTurns,
          });
          if (verdict.met) {
            this.stop('met');
            return;
          }
        }

        if (this.goal.turns >= this.options.config.goalMaxTurns) {
          this.stop('max-turns');
          return;
        }
        directive = this.takePending() ?? { text: guidanceFor(this.goal) };
      }
    } finally {
      this.supervising = false;
      // 循环收尾时仍有在途的用户消息:立刻作为独立一轮发出去。吞掉它是本
      // 仓库最忌讳的失败模式——UI 已经回显过,历史里却没有。
      const leftover = this.takePending();
      if (leftover) void this.options.agent.run(leftover.text, runOptions(leftover));
    }
  }

  /** 退订事件总线。 */
  dispose(): void {
    this.off();
  }

  private takePending(): Directive | undefined {
    const pending = this.pending;
    this.pending = undefined;
    return pending;
  }

  /**
   * 记下会话累计 token。
   *
   * 累计值变小意味着 agent 那边把计数清零了(`agent.clear()`、`setHistory
   * ({resetSpend})`,见 loop.ts:150,170)——`/resume` 就是这条路。基线不跟着
   * 回落的话,spend() 会一直被夹成 0,`/goal` 状态里的花销要等新会话烧过旧
   * 会话的总量才开始动。
   */
  private observeSpend(total: number): void {
    if (total < this.cumulative && this.goal) this.goal.tokenBaseline = total;
    this.cumulative = total;
  }

  private spend(goal: GoalState): number {
    // 夹一下兜底:计数清零与下一次 usage 事件之间仍有一段基线偏高的窗口。
    return Math.max(0, this.cumulative - goal.tokenBaseline) + goal.evaluatorTokens;
  }

  private stop(reason: GoalStopReason): void {
    const goal = this.goal;
    if (!goal) return;
    this.options.bus.emit({
      type: 'goal-stop',
      reason,
      condition: goal.condition,
      detail: goal.lastReason,
      turns: goal.turns,
      elapsedMs: Date.now() - goal.startedAt,
      tokens: this.spend(goal),
    });
    this.goal = undefined;
    this.generation++;
    // 在途的评估请求就此作废:结果已经没人要了,还占着 supervising 不放。
    this.evaluation?.abort();
    this.evaluation = undefined;
    this.options.onChange?.();
  }

  /**
   * 判一次条件有没有达成。绝不抛异常:评估失败只是"这次没判出来",不该把
   * 用户那一轮的 Promise 一起拒绝掉。判不出来返回 undefined,由调用方计入
   * 连续失败次数。
   */
  private async evaluate(condition: string): Promise<{ met: boolean; reason: string } | undefined> {
    const controller = new AbortController();
    this.evaluation = controller;
    try {
      const result = await generateText({
        model: this.options.evaluatorModel(),
        messages: [
          {
            role: 'user',
            content: evaluatorPrompt(condition, renderTranscript(this.options.agent.history)),
          },
        ],
        abortSignal: controller.signal,
      });
      if (this.goal) this.goal.evaluatorTokens += result.usage.totalTokens ?? 0;
      return parseVerdict(result.text);
    } catch {
      return undefined;
    } finally {
      if (this.evaluation === controller) this.evaluation = undefined;
    }
  }
}

/**
 * 评估器提示词。喂模型的文本一律英文(见 CLAUDE.md 的 i18n 约定)。
 *
 * 要的是两行前缀而不是 JSON:评估器本就该用小模型,而小模型最会写错的
 * 恰恰是"只回一行 JSON"。理由和不用 generateObject 是同一条——各家
 * OpenAI 兼容端点的 JSON mode 支持参差不齐,不能把正确性押在格式上。
 *
 * 反复强调"只能从记录判断":评估器没有工具,一旦它开始相信 agent 自称的
 * "测试应该能过",这个循环就会在什么都没验证的情况下宣告成功。
 */
function evaluatorPrompt(condition: string, transcript: string): string {
  return (
    'You are checking whether a coding agent has satisfied a completion condition.\n\n' +
    `Completion condition:\n${condition}\n\n` +
    `Recent transcript (oldest first, truncated):\n${transcript}\n\n` +
    'Reply with exactly two lines and nothing else:\n' +
    'VERDICT: <MET or NOT_MET>\n' +
    'REASON: <one sentence. If NOT_MET, say concretely what is missing and what to do next.>\n\n' +
    'Judge only from evidence in the transcript. A stated intention or a plan is not ' +
    'completion. If the transcript does not show the condition being satisfied, answer NOT_MET.'
  );
}

/**
 * 未达成时下一轮的指令。同样是喂模型的文本,保持英文。
 *
 * 不套 display 直接进历史(与 `/plan <任务>` 同一条道理):时间线看到的就是
 * 历史里的内容,`/resume` 回放与 esc-esc 回退才不会和实时界面对不上。
 */
function guidanceFor(goal: GoalState): string {
  const reason = goal.lastReason || 'The evaluator could not tell yet whether the goal is met.';
  return (
    `The goal is not met yet: ${reason}\n\n` +
    `Goal: ${goal.condition}\n\n` +
    'Keep working until the goal is satisfied. Do not ask the user whether to continue — ' +
    'they set this goal and expect you to carry on. Report back only when the goal is met ' +
    'or you are genuinely blocked.'
  );
}

function runOptions(
  directive: Directive,
): { display?: string; images?: ImageAttachment[] } | undefined {
  const options = {
    ...(directive.display ? { display: directive.display } : {}),
    ...(directive.images?.length ? { images: directive.images } : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

function mergeImages(
  a: ImageAttachment[] | undefined,
  b: ImageAttachment[] | undefined,
): { images?: ImageAttachment[] } {
  const merged = [...(a ?? []), ...(b ?? [])];
  return merged.length > 0 ? { images: merged } : {};
}

/**
 * 把历史尾部渲染成纯文本抄本,而不是把 ModelMessage[] 原样转发给评估器。
 *
 * 原样转发要处理工具调用与其结果的配对:尾部切片一旦以 `role:'tool'` 开头,
 * provider 会以 400 拒收找不到对应调用的工具结果——和 compact.ts:53-61 是同
 * 一条教训,而那里为此专门写了一段切点调整。抄本彻底绕开这个问题,顺带能
 * 逐条截断:一次 read 读进来的三千行文件,不截的话会把这次"便宜的评估"
 * 直接撑成整轮里最贵的一次调用。
 */
export function renderTranscript(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const message of messages.slice(-TAIL_MESSAGES)) {
    const body = renderContent(message.content);
    if (body.trim()) lines.push(`[${message.role}]\n${body}`);
  }
  const text = lines.join('\n\n');
  if (!text) return '(no conversation yet)';
  return text.length > TOTAL_CHARS ? `…[earlier truncated]\n${text.slice(-TOTAL_CHARS)}` : text;
}

function renderContent(content: unknown): string {
  if (typeof content === 'string') return truncate(content);
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const raw of content) {
    const part = raw as Record<string, unknown>;
    switch (part['type']) {
      case 'text':
        if (typeof part['text'] === 'string') out.push(truncate(part['text']));
        break;
      case 'tool-call':
        out.push(`→ ${String(part['toolName'])} ${truncate(stringify(part['input']))}`);
        break;
      case 'tool-result':
        out.push(`← ${String(part['toolName'])} ${truncate(stringify(part['output']))}`);
        break;
      case 'file':
        // 图片对"做到没有"几乎没有贡献,却按整张计费,文本模型还会直接拒收。
        out.push('[image]');
        break;
      default:
        // reasoning 等片段跳过:思考过程说明不了结果。
        break;
    }
  }
  return out.join('\n');
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function truncate(text: string): string {
  return text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS)}…[truncated]` : text;
}

/**
 * 从评估器的回复里抠出判词。判不出来返回 undefined——由调用方计入连续失败,
 * 而不是在这里瞎猜一个 false,那会让"评估器坏了"和"确实没做完"混为一谈。
 *
 * 判 MET 和判不出来的代价完全不对称:误判达成会一声不响地把活停在半截,而
 * 判不出来最多多跑一轮、连着两次才解除目标并明说原因。所以这里宁严勿宽——
 * 取的是 `VERDICT:` 那一整行,规范化后必须**恰好**是 MET 或 NOT_MET:
 *
 * - 弱模型常把格式说明整行抄回来(`VERDICT: MET or NOT_MET`)。子串匹配会
 *   命中其中的 MET,当场宣告达成——这是本功能最坏的失败模式。
 * - 反过来 `VERDICT: **MET**`、`VERDICT: MET.` 这类装饰要认,不能白白浪费
 *   一次正确的判定。
 */
export function parseVerdict(text: string): { met: boolean; reason: string } | undefined {
  const clean = text.replace(/```[a-z]*\n?/gi, '').trim();

  const lines = clean.split('\n');
  const index = lines.findIndex((line) => /^VERDICT[:：]/i.test(undecorate(line)));
  if (index !== -1) {
    // 只在认前缀和判词时剥 markdown 装饰;理由取原文,免得把 `snake_case`
    // 或反引号里的标识符一起削掉。
    const token = undecorate(lines[index]!)
      .replace(/^VERDICT[:：]/i, '')
      .replace(/[<>[\]().,。,、\s-]/g, '')
      .toUpperCase();
    // 含 NOTMET 的一律按未达成处理:抄回说明的那一行两个词都在,不能算达成。
    if (token.startsWith('NOTMET')) return { met: false, reason: reasonFrom(lines) };
    if (token.startsWith('MET') && !token.includes('NOTMET')) {
      return { met: true, reason: reasonFrom(lines) };
    }
    // 落到这里说明那一行读不懂,继续试 JSON 分支。
  }

  // 回退:训练里见惯 JSON 的模型仍会自作主张回一个对象。
  for (const candidate of jsonCandidates(clean)) {
    try {
      const parsed = JSON.parse(candidate) as { met?: unknown; reason?: unknown };
      if (typeof parsed.met !== 'boolean') continue;
      return {
        met: parsed.met,
        reason: tidyReason(typeof parsed.reason === 'string' ? parsed.reason : ''),
      };
    } catch {
      // 试下一个候选
    }
  }
  return undefined;
}

/** 剥掉 markdown 装饰,只用于认前缀和判词——`**VERDICT:** MET` 很常见。 */
function undecorate(line: string): string {
  return line.replace(/[*`_>#]/g, '').trim();
}

/** REASON 之后的内容,可能折了行。取不到就返回空串,由调用方兜一句默认。 */
function reasonFrom(lines: string[]): string {
  const index = lines.findIndex((line) => /^REASON[:：]/i.test(undecorate(line)));
  if (index === -1) return '';
  const head = lines[index]!.replace(/^[\s*`_>#]*REASON[:：]/i, '');
  return tidyReason([head, ...lines.slice(index + 1)].join(' '));
}

function tidyReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim().slice(0, 400);
}

function* jsonCandidates(text: string): Generator<string> {
  const greedy = /\{[\s\S]*\}/.exec(text);
  if (greedy) yield greedy[0];
  // 模型常在解释之后又补一个 JSON,贪婪匹配会把解释也括进去。
  for (const match of text.matchAll(/\{[^{}]*\}/g)) yield match[0];
}
