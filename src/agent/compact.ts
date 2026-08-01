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
 * Decides whether the history needs compacting.
 *
 * We use the provider-reported input token count from the last step rather than
 * a local tokenizer: the three providers tokenise Chinese very differently and
 * a JS estimate would be off by enough to either compact too early or blow the
 * window.
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
 * Replaces the older part of the history with a summary, keeping the most
 * recent exchanges verbatim.
 *
 * The cut point is snapped forward to the next user message so we never split
 * an assistant tool-call from its tool-result — providers reject a tool result
 * whose call is missing, and that failure mode is confusing to debug.
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
