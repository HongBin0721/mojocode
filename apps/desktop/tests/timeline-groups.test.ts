/**
 * 渲染期分组(timeline-groups):探索段聚合、微思考并卡、todo 去重,以及
 * 流式(open)与已收尾两种状态下的尾部语义。
 */

import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '@core/types';
import { groupTimeline } from '../src/renderer/utils/timeline-groups.js';

let seq = 0;
const tool = (
  toolName: string,
  over: Partial<Extract<TimelineItem, { kind: 'tool' }>> = {},
): TimelineItem => ({
  kind: 'tool',
  key: `t${seq++}`,
  toolName,
  input: {},
  summary: '',
  output: '',
  isError: false,
  durationMs: 100,
  ...over,
});
const reasoning = (text: string, durationMs?: number): TimelineItem => ({
  kind: 'reasoning',
  key: `r${seq++}`,
  text,
  ...(durationMs !== undefined ? { durationMs } : {}),
});
const assistant = (text: string): TimelineItem => ({ kind: 'assistant', key: `a${seq++}`, text });

describe('groupTimeline · 探索段聚合', () => {
  it('连续 ≥2 个探索工具合成一条 explore,统计按类别归位', () => {
    const items = [
      tool('read', { input: { path: 'a.ts' } }),
      tool('read', { input: { path: 'b.ts' } }),
      tool('read', { input: { path: 'a.ts' } }), // 重复路径去重
      tool('grep'),
      tool('web_search'),
      assistant('看完了'),
    ];
    const entries = groupTimeline(items);
    expect(entries).toHaveLength(2);
    const group = entries[0]!;
    if (group.kind !== 'explore') throw new Error('expected explore');
    expect(group.steps).toHaveLength(5);
    expect(group.reads).toBe(2);
    expect(group.searches).toBe(1);
    expect(group.web).toBe(1);
    expect(group.durationMs).toBe(500);
  });

  it('段内穿插的思考收进组(时长计入),尾部思考退回主流', () => {
    const items = [
      tool('read'),
      reasoning('看看别的文件', 1200),
      tool('glob'),
      reasoning('准备写代码了', 800),
      assistant('好的'),
    ];
    const entries = groupTimeline(items);
    expect(entries.map((entry) => entry.kind)).toEqual(['explore', 'item', 'item']);
    const group = entries[0]!;
    if (group.kind !== 'explore') throw new Error('expected explore');
    expect(group.steps).toHaveLength(3);
    expect(group.thoughtMs).toBe(1200);
    // 尾部思考(微思考,但后面不是工具)保持原条目
    expect(entries[1]).toMatchObject({ kind: 'item', item: { kind: 'reasoning' } });
  });

  it('单个探索工具不成组;失败的探索工具不进组', () => {
    const single = groupTimeline([tool('read'), assistant('x')]);
    expect(single.map((entry) => entry.kind)).toEqual(['item', 'item']);

    const withError = groupTimeline([
      tool('read'),
      tool('read', { isError: true }),
      tool('read'),
    ]);
    // 错误卡把段切开,两侧各剩 1 个 → 都不成组
    expect(withError.map((entry) => entry.kind)).toEqual(['item', 'item', 'item']);
  });

  it('bash/write 等非探索工具切断探索段', () => {
    const entries = groupTimeline([
      tool('read'),
      tool('bash'),
      tool('read'),
      tool('grep'),
      assistant('ok'),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(['item', 'item', 'explore', 'item']);
  });

  it('open(流式)时尾部未关上的段不成组;已收尾(默认)时尾部照常成组', () => {
    const items = [tool('read'), tool('read')];
    expect(groupTimeline(items, { open: true }).map((entry) => entry.kind)).toEqual([
      'item',
      'item',
    ]);
    // 回放/休眠复活走默认:同一段历史不因打开方式渲染不同
    expect(groupTimeline(items).map((entry) => entry.kind)).toEqual(['explore']);
  });
});

describe('groupTimeline · 微思考并卡', () => {
  it('微思考并进下一张普通工具卡(时长 + 原文)', () => {
    const entries = groupTimeline([reasoning('先跑测试', 900), tool('bash'), assistant('ok')]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: 'item',
      thoughtMs: 900,
      thoughtText: '先跑测试',
    });
  });

  it('open(流式)时目标工具还是最后一条:先不折,等关上再折', () => {
    const items = [reasoning('先跑测试', 900), tool('bash')];
    const open = groupTimeline(items, { open: true });
    expect(open.map((entry) => entry.kind)).toEqual(['item', 'item']);
    expect(open[0]).toMatchObject({ item: { kind: 'reasoning' } });
    // 已收尾:折
    expect(groupTimeline(items)).toHaveLength(1);
  });

  it('空文本思考挂不上工具就丢弃;有内容的保留', () => {
    const dropped = groupTimeline([reasoning('', 500), assistant('回复')]);
    expect(dropped.map((entry) => entry.kind)).toEqual(['item']);

    const kept = groupTimeline([reasoning('短想法', 500), assistant('回复')]);
    expect(kept.map((entry) => entry.kind)).toEqual(['item', 'item']);
  });

  it('多行/长思考不算微思考,独立成条', () => {
    const entries = groupTimeline([reasoning('第一行\n第二行', 500), tool('bash'), assistant('x')]);
    expect(entries[0]).toMatchObject({ kind: 'item', item: { kind: 'reasoning' } });
  });

  it('微思考不挂到 todo/exit_plan 专门卡上', () => {
    const entries = groupTimeline([reasoning('更新清单', 300), tool('todo')]);
    expect(entries.map((entry) => entry.kind)).toEqual(['item', 'item']);
    expect(entries[1]).not.toHaveProperty('thoughtMs');
  });
});

describe('groupTimeline · todo 去重', () => {
  const todoTool = (todos: { content: string; status: string }[]): TimelineItem =>
    tool('todo', { input: { todos } });

  it('只有末次 todo 保留完整清单,更早的压成差分行', () => {
    const entries = groupTimeline([
      todoTool([{ content: '任务A', status: 'pending' }]),
      todoTool([{ content: '任务A', status: 'completed' }]),
      todoTool([
        { content: '任务A', status: 'completed' },
        { content: '任务B', status: 'pending' },
      ]),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(['todo-update', 'todo-update', 'item']);
    expect(entries[0]).toMatchObject({ completed: [], added: ['任务A'] });
    expect(entries[1]).toMatchObject({ completed: ['任务A'], added: [] });
  });

  it('失败/无清单的 todo 调用不参与去重,照常渲染工具卡', () => {
    const entries = groupTimeline([
      tool('todo', { isError: true, input: { todos: [{ content: 'x', status: 'pending' }] } }),
      todoTool([{ content: 'x', status: 'pending' }]),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(['item', 'item']);
  });
});
