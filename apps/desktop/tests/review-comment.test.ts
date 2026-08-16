/**
 * 行评论消息模板测试:双语言 × old/new 侧、display 标签、防御。
 */

import { describe, expect, it } from 'vitest';
import { setLocale } from '../src/renderer/i18n/index.js';
import { buildReviewComment } from '../src/renderer/utils/review-comment.js';

describe('buildReviewComment', () => {
  it('zh-CN:新文件行指向当前行号,删除行标注已删除', () => {
    setLocale('zh-CN');
    const added = buildReviewComment({ path: 'src/a.ts', line: 42, side: 'new', comment: '这里漏了空指针检查' });
    expect(added.text).toBe('请处理这条代码评审意见:src/a.ts 第 42 行:这里漏了空指针检查');
    expect(added.display).toBe('💬 src/a.ts:42');

    const removed = buildReviewComment({ path: 'src/a.ts', line: 7, side: 'old', comment: '这行为什么删?' });
    expect(removed.text).toContain('已删除的第 7 行');
    expect(removed.display).toBe('💬 src/a.ts:7');
  });

  it('en:模板带反引号路径与行号', () => {
    setLocale('en');
    const added = buildReviewComment({ path: 'src/a.ts', line: 3, side: 'new', comment: 'rename this' });
    expect(added.text).toBe('Review comment on `src/a.ts` line 3:\nrename this');
    const removed = buildReviewComment({ path: 'src/a.ts', line: 3, side: 'old', comment: 'why?' });
    expect(removed.text).toBe('Review comment on `src/a.ts` (removed line 3):\nwhy?');
  });

  it('空评论 / 非法行号抛错(调用方拦截,不发出空轮)', () => {
    setLocale('zh-CN');
    expect(() => buildReviewComment({ path: 'a', line: 1, side: 'new', comment: '   ' })).toThrow();
    expect(() => buildReviewComment({ path: 'a', line: 0, side: 'new', comment: 'x' })).toThrow();
    expect(() => buildReviewComment({ path: 'a', line: Number.NaN, side: 'new', comment: 'x' })).toThrow();
  });
});
