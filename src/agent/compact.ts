import { generateText, type LanguageModel, type ModelMessage } from 'ai';

const SUMMARY_INSTRUCTION = `Summarise the conversation so far so that another instance of you can
pick the work up with no other context. Be specific and factual — this replaces the transcript.

Cover, as applicable:
1. What the user asked for, in their own terms, including any constraints they stated.
2. Files read or modified, with paths, and what changed in each.
3. Commands run and their outcomes (especially failures and error messages).
4. Decisions made and why, including approaches tried and rejected.
5. What is still outstanding, and the exact next step.

Write it as plain prose with headings. Do not add commentary about summarising.`;

/**
 * 摘要请求里不重传历史图片:把用户消息中的 file part 换成文本占位。
 * 图片对"接下来该干什么"的摘要几乎无贡献,却按整张的 token 计费,
 * 且文本模型会直接拒收。只映射发给摘要模型的副本,持久历史不动。
 */
function stripImageParts(message: ModelMessage): ModelMessage {
  if (message.role !== 'user' || !Array.isArray(message.content)) return message;
  if (!message.content.some((part) => part.type === 'file')) return message;
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === 'file' ? { type: 'text' as const, text: '[image omitted]' } : part,
    ),
  };
}

export interface CompactionResult {
  messages: ModelMessage[];
  removedMessages: number;
  summaryChars: number;
}

/**
 * 判断历史是否需要压缩。
 *
 * 我们使用上一步中 provider 上报的输入 token 数,而不是本地分词器:三家
 * provider 对中文的分词方式差异很大,JS 估算的误差足以导致过早压缩或者
 * 直接撑爆上下文窗口。
 */
export function shouldCompact(
  lastInputTokens: number | undefined,
  contextWindow: number,
  threshold: number,
): boolean {
  if (!lastInputTokens) return false;
  return lastInputTokens > contextWindow * threshold;
}

/**
 * 用摘要替换历史中较早的部分,最近的几轮对话原样保留。
 *
 * 切分点向后跳过工具结果:工具结果必须和产生它的 assistant 调用留在同一
 * 侧,否则 provider 会拒绝找不到对应调用的工具结果,而这种失败模式调试起
 * 来非常费解。assistant 与 user 都是安全的切点——只认 user 会让轮内压缩
 * 完全失效:长工具循环的尾部全是 assistant/tool,根本没有更晚的用户消息,
 * 于是最该压缩的场景反而永远返回 0。
 */
export async function compactMessages(
  messages: ModelMessage[],
  model: LanguageModel,
  keepRecent = 6,
): Promise<CompactionResult> {
  if (messages.length <= keepRecent + 2) {
    return { messages, removedMessages: 0, summaryChars: 0 };
  }

  let cut = Math.max(1, messages.length - keepRecent);
  while (cut < messages.length && messages[cut]?.role === 'tool') cut++;
  if (cut >= messages.length) {
    return { messages, removedMessages: 0, summaryChars: 0 };
  }

  const toSummarize = messages.slice(0, cut).map(stripImageParts);
  const toKeep = messages.slice(cut);

  const { text } = await generateText({
    model,
    messages: [...toSummarize, { role: 'user', content: SUMMARY_INSTRUCTION }],
  });

  const summary: ModelMessage = {
    role: 'user',
    content: `[Earlier conversation, compacted]\n\n${text}\n\n[End of compacted history — continue from here.]`,
  };

  return {
    messages: [summary, ...toKeep],
    removedMessages: toSummarize.length,
    summaryChars: text.length,
  };
}
