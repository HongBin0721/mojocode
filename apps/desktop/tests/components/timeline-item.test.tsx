// @vitest-environment jsdom
/**
 * 时间线条目四种形态(设计稿):user 气泡 / assistant 头像 / plan 步骤卡
 * (含回退)/ tool 折叠卡展开高亮。
 */

import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TimelineItemView } from '../../src/renderer/components/TimelineItemView.js';
import { setLocale } from '../../src/renderer/i18n/index.js';
import type { TimelineItem } from '@core/types';

beforeEach(() => setLocale('zh-CN'));

const toolItem = (over: Partial<Extract<TimelineItem, { kind: 'tool' }>>): TimelineItem =>
  ({
    kind: 'tool',
    key: 'k1',
    toolName: 'bash',
    input: {},
    summary: 'exit 0',
    output: '',
    isError: false,
    durationMs: 10,
    ...over,
  }) as TimelineItem;

describe('TimelineItemView', () => {
  it('user 右气泡;assistant 带头像', () => {
    const { container, rerender } = render(
      <TimelineItemView item={{ kind: 'user', key: 'u1', text: '你好' } as TimelineItem} />,
    );
    expect(container.querySelector('.entry-user')).toBeTruthy();

    rerender(
      <TimelineItemView
        item={{ kind: 'assistant', key: 'a1', text: '回复', continuation: false } as TimelineItem}
      />,
    );
    expect(container.querySelector('.entry-avatar')).toBeTruthy();
  });

  it('exit_plan:结构化步骤渲染为计划卡;无结构回退 Markdown', () => {
    const planInput = { plan: '- [x] 第一步\n- [ ] 第二步' };
    const { container } = render(
      <TimelineItemView item={toolItem({ toolName: 'exit_plan', input: planInput })} />,
    );
    expect(screen.getByText('执行计划')).toBeTruthy();
    expect(container.querySelectorAll('.plan-step')).toHaveLength(2);
    expect(container.querySelector('.plan-step-done')).toBeTruthy();

    const fallback = render(
      <TimelineItemView
        item={toolItem({ toolName: 'exit_plan', input: { plan: '一段没有步骤的说明。' } })}
      />,
    );
    // 回退路径:不渲染步骤行,但正文仍在(不白屏)。
    expect(fallback.container.querySelector('.plan-step')).toBeNull();
    expect(fallback.container.textContent).toContain('一段没有步骤的说明。');
  });

  it('tool 卡展开:输出经 tokenize 上色,CJK 行整行弱色', () => {
    const { container } = render(
      <TimelineItemView
        item={toolItem({ output: 'const x = 1;\n读取完成', input: { path: 'a.ts' } })}
      />,
    );
    fireEvent.click(container.querySelector('.tool-row')!);
    expect(container.querySelector('.tok-kw')?.textContent).toBe('const');
    expect(container.querySelector('.tool-line-plain')?.textContent).toBe('读取完成');
  });
});
