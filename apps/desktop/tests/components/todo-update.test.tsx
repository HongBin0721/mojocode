// @vitest-environment jsdom
/**
 * todo 差分行:完成/新增/兜底文案;工具卡显示名走 Title Case 映射。
 */

import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { TodoUpdateLine } from '../../src/renderer/components/TodoUpdateLine.js';
import { ToolCard } from '../../src/renderer/components/ToolCard.js';
import { setLocale } from '../../src/renderer/i18n/index.js';

beforeEach(() => setLocale('zh-CN'));

describe('TodoUpdateLine', () => {
  it('完成条目:✓ + 文案,多项带计数', () => {
    const { container } = render(<TodoUpdateLine completed={['写测试', '跑构建']} added={[]} />);
    expect(container.textContent).toContain('✓');
    expect(container.textContent).toContain('完成 写测试 等 1 项');
  });

  it('同批既完成又新增:两个桶都报', () => {
    const { container } = render(
      <TodoUpdateLine completed={['任务A']} added={['任务B', '任务C']} />,
    );
    expect(container.textContent).toContain('完成 任务A');
    expect(container.textContent).toContain('新增 任务B 等 1 项');
  });

  it('新增条目与空差分兜底', () => {
    const added = render(<TodoUpdateLine completed={[]} added={['新任务']} />);
    expect(added.container.textContent).toContain('新增 新任务');

    const noop = render(<TodoUpdateLine completed={[]} added={[]} />);
    expect(noop.container.textContent).toContain('清单已更新');
  });
});

describe('ToolCard 显示名', () => {
  it('原始 toolName 映射为 Title Case(web_search → Web Search)', () => {
    const { container } = render(
      <ToolCard
        toolName="web_search"
        input={{}}
        summary=""
        output=""
        isError={false}
        durationMs={10}
      />,
    );
    expect(container.querySelector('.tool-name')?.textContent).toBe('Web Search');
  });
});
