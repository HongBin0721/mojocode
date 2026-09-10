/**
 * `/goal` 的评估器:把历史尾部渲染成抄本、问一个(便宜的)模型"条件达成没有"、
 * 从回复里抠出判词。纯函数为主,便于单测;唯一的副作用在 evaluateGoal 里。
 * 喂模型的文本一律英文(见 CLAUDE.md 的 i18n 约定)。
 */

import { generateText, type LanguageModel, type ModelMessage } from 'ai';

/** 评估器看到的历史条数,以及每条、总共保留的字符数。 */
const TAIL_MESSAGES = 14;
const MESSAGE_CHARS = 800;
const TOTAL_CHARS = 12_000;

export interface Verdict {
  met: boolean;
  reason: string;
}

export interface EvaluateOptions {
  model: LanguageModel;
  condition: string;
  history: ModelMessage[];
  signal?: AbortSignal;
}

export interface EvaluateResult {
  /** 判不出来时缺省,由调用方计入连续失败次数。 */
  verdict?: Verdict;
  /** 评估器自身的消耗。 */
  tokens: number;
}

/**
 * 判一次条件有没有达成。绝不抛异常:评估失败只是"这次没判出来",不该把
 * 用户那一轮一起拒绝掉。判不出来 verdict 缺省,由调用方计入连续失败次数。
 */
export async function evaluateGoal(options: EvaluateOptions): Promise<EvaluateResult> {
  try {
    const result = await generateText({
      model: options.model,
      messages: [
        {
          role: 'user',
          content: evaluatorPrompt(options.condition, renderTranscript(options.history)),
        },
      ],
      abortSignal: options.signal,
    });
    return { verdict: parseVerdict(result.text), tokens: result.usage.totalTokens ?? 0 };
  } catch {
    return { tokens: 0 };
  }
}

/**
 * 评估器提示词。
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
export function guidanceFor(condition: string, lastReason: string): string {
  const reason = lastReason || 'The evaluator could not tell yet whether the goal is met.';
  return (
    `The goal is not met yet: ${reason}\n\n` +
    `Goal: ${condition}\n\n` +
    'Keep working until the goal is satisfied. Do not ask the user whether to continue — ' +
    'they set this goal and expect you to carry on. Report back only when the goal is met ' +
    'or you are genuinely blocked.'
  );
}

/**
 * 把历史尾部渲染成纯文本抄本,而不是把 ModelMessage[] 原样转发给评估器。
 *
 * 原样转发要处理工具调用与其结果的配对:尾部切片一旦以 `role:'tool'` 开头,
 * provider 会以 400 拒收找不到对应调用的工具结果——和 compact.ts 是同一条
 * 教训,而那里为此专门写了一段切点调整。抄本彻底绕开这个问题,顺带能逐条
 * 截断:一次 read 读进来的三千行文件,不截的话会把这次"便宜的评估"直接撑
 * 成整轮里最贵的一次调用。
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
export function parseVerdict(text: string): Verdict | undefined {
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
