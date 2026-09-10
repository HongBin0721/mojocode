// @vitest-environment jsdom
/**
 * 时间线条目四种形态(设计稿):user 气泡 / assistant 头像 / plan 步骤卡
 * (含回退)/ tool 折叠卡展开高亮。
 */

import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TimelineItemView } from '../../src/renderer/components/TimelineItemView.js';
import { TRUNCATED_MARK } from '../../src/renderer/components/ToolCard.js';
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


  it('diff 卡统计走 parseDiffLines;截断的 diff 数字带 + 后缀', () => {
    const diff = '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n+new line\n-old line';
    const { container } = render(
      <TimelineItemView item={toolItem({ toolName: 'edit', output: { diff } })} />,
    );
    expect(container.querySelector('.tool-diffstat .diff-add')?.textContent).toBe('+1');
    expect(container.querySelector('.tool-diffstat .diff-del')?.textContent).toBe('−1');

    const truncated = render(
      <TimelineItemView
        item={toolItem({
          toolName: 'write',
          output: { diff: `${diff}\n\n${TRUNCATED_MARK}900 more characters)` },
        })}
      />,
    );
    expect(truncated.container.querySelector('.tool-diffstat .diff-add')?.textContent).toBe('+1+');
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
