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
 * 切分点会向后对齐到下一条用户消息,确保永远不会把 assistant 的工具调用
 * 和它的工具结果拆开——provider 会拒绝找不到对应调用的工具结果,而这种
 * 失败模式调试起来非常费解。
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
  while (cut < messages.length && messages[cut]?.role !== 'user') cut++;
  if (cut >= messages.length) {
    return { messages, removedMessages: 0, summaryChars: 0 };
  }

  const toSummarize = messages.slice(0, cut);
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
