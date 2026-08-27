import { streamText, type LanguageModel, type ModelMessage } from 'ai';

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
 * 把用户消息中的 file part 换成文本占位。带 filename 的一律是 @ 引用图
 * (buildUserContent 只给能按路径读回的图写 filename),所以占位里点名它是
 * 安全的——模型可用 view_image 按需读回。两个消费方,口径必须一致:压缩
 * 摘要不重传历史图片(几乎无贡献却按整张计费,文本摘要模型还会拒收);
 * agent 循环在当前模型非视觉时对发送副本剥图(历史里视觉模型时期直发的
 * 内联图会被文本端点整单 400)。只映射副本,持久历史不动。
 */
export function stripImageParts(message: ModelMessage): ModelMessage {
  if (message.role !== 'user' || !Array.isArray(message.content)) return message;
  if (!message.content.some((part) => part.type === 'file')) return message;
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === 'file'
        ? {
            type: 'text' as const,
            text: part.filename ? `[image omitted: ${part.filename}]` : '[image omitted]',
          }
        : part,
    ),
  };
}

/**
 * 压缩摘要消息的开头标记。渲染层(replay)靠它识别摘要消息,存储层(store)
 * 靠它识别压缩型 snapshot——这里是唯一的写入方,别处只 import。
 */
export const COMPACT_MARKER = '[Earlier conversation, compacted]';

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
 * 本地粗估一段历史的 token 数。**只在没有 provider 上报数可用时兜底**——
 * 换掉整段历史(恢复会话、回退截断)之后,`lastInputTokens` 必然作废,
 * 而 `shouldCompact(undefined, …)` 恒为 false,于是第一轮会把整段历史原样
 * 发出去。以前这不出事:恢复会切回记录里的模型,历史必定装得下;现在恢复
 * 沿用当前模型,一段长会话恢复到小窗口模型上,第一轮就会 400,且因为
 * lastInputTokens 仍是 undefined,重试多少次都同样失败。
 *
 * 估算规则:CJK 字符按 1 token,其余按 1/4 token(空白不计)。分词器差异
 * 正是 shouldCompact 不用本地估算的原因,所以这里的结果只用来*触发*一次
 * 压缩,永远不用来判断"不需要压缩"——高估最多多跑一次摘要,低估则退回
 * 到原来的行为,两个方向都不会比现状更糟。
 */
export function estimateTokens(messages: ModelMessage[]): number {
  let cjk = 0;
  let other = 0;
  for (const message of messages) {
    // 图片按 stripImageParts 的口径剔除:base64 blob 的字符数与它的 token
    // 成本毫无关系,算进去能把估算抬高几个数量级。
    const content = stripImageParts(message).content;
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    for (const char of text) {
      if (WHITESPACE.test(char)) continue;
      if (CJK.test(char)) cjk++;
      else other++;
    }
  }
  return cjk + Math.ceil(other / 4);
}

// CJK 统一表意文字 + 假名 + 谚文 + 全角标点。提到循环外只为省去重复编译;
// 不能带 /g——lastIndex 会在调用之间残留,让每隔一个字符就漏判一次。
const CJK = /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;
const WHITESPACE = /\s/;

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
  /**
   * 摘要生成的流式进度:首次以 0 调用(请求已发出、首个增量未到),之后为
   * 已生成的累计字符数。历史太短等提前返回的分支不会调用它——调用方可以
   * 据此区分「真的去请求模型了」和「无事发生」。
   */
  onProgress?: (chars: number) => void,
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

  // 用 streamText 而不是 generateText,只为把进度喂给 onProgress。注意
  // streamText 的流会吞掉错误(textStream 的文档明说错误不进流,要靠
  // onError 观察),这里收集起来在消费完后重抛,保持与 generateText 一致的
  // 失败语义——压缩失败必须让调用方看得见。
  let streamError: unknown;
  onProgress?.(0);
  const result = streamText({
    model,
    messages: [...toSummarize, { role: 'user', content: SUMMARY_INSTRUCTION }],
    onError: ({ error }) => {
      streamError = error;
    },
  });

  let text = '';
  for await (const delta of result.textStream) {
    text += delta;
    onProgress?.(text.length);
  }
  if (streamError !== undefined) throw streamError;

  const summary: ModelMessage = {
    role: 'user',
    content: `${COMPACT_MARKER}\n\n${text}\n\n[End of compacted history — continue from here.]`,
  };

  return {
    messages: [summary, ...toKeep],
    removedMessages: toSummarize.length,
    summaryChars: text.length,
  };
}
