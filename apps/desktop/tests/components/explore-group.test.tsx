// @vitest-environment jsdom
/**
 * 探索聚合卡:收起只有一行摘要,展开逐条渲染原工具卡;工具卡的微思考
 * chip 渲染时长并把原文挂 title。
 */

import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { TimelineItem } from '@core/types';
import { ExploreGroup } from '../../src/renderer/components/ExploreGroup.js';
import { ToolCard } from '../../src/renderer/components/ToolCard.js';
import { groupTimeline } from '../../src/renderer/utils/timeline-groups.js';
import { setLocale } from '../../src/renderer/i18n/index.js';

beforeEach(() => setLocale('zh-CN'));

let seq = 0;
const tool = (toolName: string, path?: string): TimelineItem => ({
  kind: 'tool',
  key: `t${seq++}`,
  toolName,
  input: path !== undefined ? { path } : {},
  summary: 'ok',
  output: '',
  isError: false,
  durationMs: 100,
});

describe('ExploreGroup', () => {
  it('收起:一行摘要;展开:逐条渲染原工具卡', () => {
    const entries = groupTimeline([
      tool('read', 'a.ts'),
      tool('read', 'b.ts'),
      tool('grep'),
      { kind: 'reasoning', key: `r${seq++}`, text: '想一下', durationMs: 2000 },
      tool('glob'),
      { kind: 'assistant', key: `a${seq++}`, text: '关上探索段' },
    ]);
    const group = entries[0]!;
    if (group.kind !== 'explore') throw new Error('expected explore');

    const { container } = render(<ExploreGroup entry={group} />);
    expect(container.textContent).toContain('探索');
    expect(container.textContent).toContain('读取 2 个文件');
    expect(container.textContent).toContain('检索 2 次');
    expect(container.textContent).toContain('思考 2.0s');
    expect(container.querySelector('.explore-steps')).toBeNull();

    fireEvent.click(container.querySelector('.tool-row')!);
    const steps = container.querySelector('.explore-steps')!;
    // 4 张工具卡 + 1 条思考块
    expect(steps.querySelectorAll('.tool-card')).toHaveLength(5);
    expect(steps.querySelector('.reasoning')).toBeTruthy();
    expect(steps.textContent).toContain('a.ts');
  });
});

describe('ToolCard 微思考 chip', () => {
  it('渲染时长并把原文挂 title', () => {
    const { container } = render(
      <ToolCard
        toolName="bash"
        input={{}}
        summary="exit 0"
        output=""
        isError={false}
        durationMs={100}
        thoughtMs={1500}
        thoughtText="先跑测试"
      />,
    );
    const chip = container.querySelector('.tool-thought')!;
    expect(chip.textContent).toContain('思考 1.5s');
    expect(chip.getAttribute('title')).toBe('先跑测试');
  });
});
