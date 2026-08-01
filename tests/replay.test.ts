import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { collectRewindEntries, replayTimeline } from '../src/session/replay.js';
import { wrapGuidance, unwrapGuidance } from '../src/agent/loop.js';

describe('replayTimeline', () => {
  it('字符串与 parts 两种形态的 user 消息都还原为 user 条目', () => {
    const items = replayTimeline([
      { role: 'user', content: '第一问' },
      { role: 'user', content: [{ type: 'text', text: '第二问' }] },
    ] as ModelMessage[]);
    expect(items).toEqual([
      { kind: 'user', text: '第一问' },
      { kind: 'user', text: '第二问' },
    ]);
  });

  it('assistant 的 text/reasoning/tool-call 按序展开,tool-result 关联回调用', () => {
    const items = replayTimeline([
      { role: 'user', content: '读个文件' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '想一想' },
          { type: 'text', text: '我来读' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'read',
            output: { type: 'json', value: { path: 'a.ts', shownLines: 10, totalLines: 10 } },
          },
        ],
      },
      { role: 'assistant', content: '读完了' },
    ] as ModelMessage[]);

    expect(items[0]).toEqual({ kind: 'user', text: '读个文件' });
    expect(items[1]).toEqual({ kind: 'reasoning', text: '想一想' });
    expect(items[2]).toEqual({ kind: 'assistant', text: '我来读' });
    expect(items[3]).toMatchObject({
      kind: 'tool',
      toolName: 'read',
      input: { path: 'a.ts' },
      isError: false,
      durationMs: 0,
    });
    expect((items[3] as { summary: string }).summary.length).toBeGreaterThan(0);
    expect(items[4]).toEqual({ kind: 'assistant', text: '读完了' });
  });

  it('error 形态的 tool-result 标记 isError 并取首行摘要', () => {
    const items = replayTimeline([
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'bash', input: { command: 'x' } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'bash',
            output: { type: 'error-text', value: 'command not found: x\n第二行不该出现在摘要里' },
          },
        ],
      },
    ] as ModelMessage[]);
    expect(items[0]).toMatchObject({
      kind: 'tool',
      isError: true,
      summary: 'command not found: x',
      output: 'command not found: x\n第二行不该出现在摘要里',
    });
  });

  it('text 形态的 tool-result 解包 value', () => {
    const items = replayTimeline([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c9',
            toolName: 'grep',
            output: { type: 'text', value: 'hit' },
          },
        ],
      },
    ] as ModelMessage[]);
    expect(items[0]).toMatchObject({ kind: 'tool', toolName: 'grep', output: 'hit', isError: false });
  });

  it('压缩摘要消息渲染为 notice,system 消息跳过', () => {
    const items = replayTimeline([
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '[Earlier conversation, compacted]\n\n摘要……' },
      { role: 'user', content: '继续' },
    ] as ModelMessage[]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'notice', level: 'info' });
    expect(items[1]).toEqual({ kind: 'user', text: '继续' });
  });

  it('引导消息解包为原文', () => {
    const items = replayTimeline([
      { role: 'user', content: wrapGuidance('顺便修一下测试') },
    ] as ModelMessage[]);
    expect(items).toEqual([{ kind: 'user', text: '顺便修一下测试' }]);
  });
});

describe('unwrapGuidance', () => {
  it('与 wrapGuidance 互逆;非包装文本返回 undefined', () => {
    expect(unwrapGuidance(wrapGuidance('多行\n原文'))).toBe('多行\n原文');
    expect(unwrapGuidance('普通消息')).toBeUndefined();
  });
});

describe('collectRewindEntries', () => {
  it('只收集真实用户消息,最新在前,引导消息还原原文', () => {
    const entries = collectRewindEntries([
      { role: 'user', content: '[Earlier conversation, compacted]\n\n摘要' },
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: wrapGuidance('中途引导') },
      { role: 'assistant', content: '答二' },
      { role: 'user', content: '第二问' },
    ] as ModelMessage[]);

    expect(entries).toEqual([
      { index: 5, ordinal: 3, text: '第二问' },
      { index: 3, ordinal: 2, text: '中途引导' },
      { index: 1, ordinal: 1, text: '第一问' },
    ]);
  });

  it('空历史返回空数组', () => {
    expect(collectRewindEntries([])).toEqual([]);
  });
});
