/**
 * diff 行评论 → 发给 agent 的消息模板。text 是模型看到的正文(带文件与
 * 行号上下文);display 是时间线气泡的短标签(run 的 display 选项经
 * turn-start 流进时间线,已验证)。
 *
 * 行号语义:add/context 行用新文件行号;del 行用旧文件行号(那行已不存在,
 * 评论指向的是被删的内容)。
 */

import { getLocale } from '../i18n/index.js';

export interface ReviewCommentInput {
  path: string;
  line: number;
  side: 'old' | 'new';
  comment: string;
}

export function buildReviewComment(input: ReviewCommentInput): { text: string; display: string } {
  const trimmed = input.comment.trim();
  if (trimmed === '' || !Number.isFinite(input.line) || input.line < 1) {
    throw new Error('评论内容为空或行号非法');
  }
  const label = `💬 ${input.path}:${input.line}`;
  if (getLocale() === 'zh-CN') {
    return {
      text:
        input.side === 'old'
          ? `请处理这条代码评审意见:${input.path}(已删除的第 ${input.line} 行):${trimmed}`
          : `请处理这条代码评审意见:${input.path} 第 ${input.line} 行:${trimmed}`,
      display: label,
    };
  }
  return {
    text:
      input.side === 'old'
        ? `Review comment on \`${input.path}\` (removed line ${input.line}):\n${trimmed}`
        : `Review comment on \`${input.path}\` line ${input.line}:\n${trimmed}`,
    display: label,
  };
}
