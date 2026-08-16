/**
 * timelineReducer 单测:与 TUI 侧 timeline-controller.ts 的行为语义 1:1
 * 对照(移植验收)。固定事件序列 → 断言 items/活动区/工作状态。
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, PermissionRequest } from '@core/events';
import { setLocale } from '../src/renderer/i18n/index.js';
import {
  initialTimelineState,
  nextKey,
  reduceTimeline,
  splitCommitted,
  type TimelineCtx,
} from '../src/renderer/state/timelineReducer.js';

// notice 文案的断言按中文目录写:显式定 locale,不依赖检测。
setLocale('zh-CN');

const makeCtx = (overrides: Partial<TimelineCtx> = {}): TimelineCtx => ({
  getModel: () => 'glm-5',
  getConfig: () => ({ plan: false, goalMaxTurns: 10 }),
  isGoalBusy: () => false,
  isGoalActive: () => false,
  isAgentRunning: () => false,
  onPermissionRequest: () => {},
  onPermissionChange: () => {},
  ...overrides,
});

const drain = (events: AgentEvent[], ctx: TimelineCtx = makeCtx()) =>
  events.reduce((state, event) => reduceTimeline(state, event, ctx), initialTimelineState(undefined));

const kinds = (state: { items: { kind: string }[] }) => state.items.map((item) => item.kind);

describe('splitCommitted(复制自 preview.ts,回归上游语义)', () => {
  it('空行收尾的段落可提交,尾段保留', () => {
    const { committed, rest } = splitCommitted('第一段。\n\n第二段还在写');
    expect(committed).toBe('第一段。');
    expect(rest).toBe('第二段还在写');
  });

  it('代码围栏内的空行不是切点', () => {
    const text = '```\na\n\nb\n```\n';
    expect(splitCommitted(text).committed).toBe('');
  });

  it('列表跨空行不切(松散列表是一个列表)', () => {
    const text = '1. 一\n\n2. 二\n';
    expect(splitCommitted(text).committed).toBe('');
  });
});

describe('reduceTimeline', () => {
  it('一轮完整对话:user → 流式文本(含段落提交)→ turn 收尾行', () => {
    const state = drain([
      { type: 'turn-start', userText: '你好' },
      { type: 'text-delta', id: 't1', text: '第一段。\n\n' },
      { type: 'text-delta', id: 't1', text: '第二段' },
      { type: 'text-end', id: 't1' },
      {
        type: 'turn-end',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cumulativeTotalTokens: 300,
          contextWindow: 128000,
        },
        finishReason: 'stop',
      },
    ]);
    expect(kinds(state)).toEqual(['user', 'assistant', 'assistant', 'turn']);
    // 段落提交的条目带 continuation 语义:后续片段渲染不带 ● 前缀。
    expect(state.items[1]).toMatchObject({ kind: 'assistant', text: '第一段。' });
    expect(state.items[2]).toMatchObject({ kind: 'assistant', text: '第二段', continuation: true });
    const turn = state.items[3] as { kind: 'turn'; model: string; tokens: number };
    expect(turn.model).toBe('glm-5');
    expect(turn.tokens).toBe(300);
    expect(state.activeText).toBe('');
    expect(state.work).toBeUndefined();
  });

  it('text-end 定稿累积文本;活动区清空', () => {
    const state = drain([
      { type: 'turn-start', userText: 'x' },
      { type: 'text-delta', id: 't1', text: 'hi' },
      { type: 'text-end', id: 't1' },
    ]);
    expect(state.activeText).toBe('');
    expect(state.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'hi' });
  });

  it('tool-start/tool-end 配对:输入在 start 记下、结果条目带 summary 与耗时', () => {
    const state = drain([
      { type: 'turn-start', userText: 'x' },
      { type: 'tool-start', callId: 'c1', toolName: 'bash', input: { command: 'ls' } },
      {
        type: 'tool-end',
        callId: 'c1',
        toolName: 'bash',
        summary: 'Ran ls',
        output: { stdout: 'a\nb' },
        isError: false,
        durationMs: 900,
      },
      { type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cumulativeTotalTokens: 2, contextWindow: 1000 }, finishReason: 'stop' },
    ]);
    const tool = state.items.find((item) => item.kind === 'tool') as {
      input: unknown;
      summary: string;
    };
    expect(tool.input).toEqual({ command: 'ls' });
    expect(tool.summary).toBe('Ran ls');
    expect(state.activeTools).toHaveLength(0);
    expect(state.toolInputs).toEqual({});
  });

  it('task-progress 按 callId 记录,tool-end 清除', () => {
    const events: AgentEvent[] = [
      { type: 'turn-start', userText: 'x' },
      { type: 'tool-start', callId: 'task1', toolName: 'task', input: {} },
      { type: 'task-progress', callId: 'task1', description: '调研', steps: 3, tokens: 1200, currentTool: 'grep' },
    ];
    let state = drain(events);
    expect(state.taskProgress['task1']).toMatchObject({ steps: 3, currentTool: 'grep' });
    state = reduceTimeline(
      state,
      { type: 'tool-end', callId: 'task1', toolName: 'task', summary: 'done', output: {}, isError: false, durationMs: 10 },
      makeCtx(),
    );
    expect(state.taskProgress['task1']).toBeUndefined();
  });

  it('permission-request 上抛回调并进入 waiting 阶段', () => {
    const onPermissionRequest = vi.fn();
    const request: PermissionRequest = { id: 'p1', toolName: 'bash', title: 'bash: ls', risk: 'execute' };
    const state = drain([{ type: 'turn-start', userText: 'x' }, { type: 'permission-request', request }], makeCtx({ onPermissionRequest }));
    expect(onPermissionRequest).toHaveBeenCalledWith(request);
    expect(state.work?.phase).toBe('waiting');
  });

  it('中断:进行中的文本定稿进时间线,活动工具清空,状态行熄灭', () => {
    const state = drain([
      { type: 'turn-start', userText: 'x' },
      { type: 'text-delta', id: 't1', text: '写到一半' },
      { type: 'tool-start', callId: 'c1', toolName: 'bash', input: {} },
      { type: 'aborted' },
    ]);
    expect(kinds(state)).toEqual(['user', 'assistant', 'notice']);
    expect(state.items[1]).toMatchObject({ text: '写到一半' });
    expect(state.activeTools).toHaveLength(0);
    expect(state.work).toBeUndefined();
  });

  it('error:同样定稿进行中文本,落 error 条目', () => {
    const state = drain([
      { type: 'turn-start', userText: 'x' },
      { type: 'text-delta', id: 't1', text: '半' },
      { type: 'error', error: new Error('boom'), recoverable: false },
    ]);
    expect(state.items.at(-1)).toMatchObject({ kind: 'error', message: 'boom' });
    expect(state.activeText).toBe('');
  });

  it('没见过 turn-start 就不画 turn 收尾行(--attach 半途接入)', () => {
    const state = drain([
      { type: 'turn-end', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10, cumulativeTotalTokens: 500, contextWindow: 1000 }, finishReason: 'stop' },
    ]);
    expect(kinds(state)).toEqual([]);
  });

  it('step-end 更新 usage;turnTokens 在轮内按增量走', () => {
    let state = drain([
      { type: 'turn-start', userText: 'x' },
      { type: 'step-end', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cumulativeTotalTokens: 120, contextWindow: 1000 } },
    ]);
    expect(state.usage).toEqual({ used: 100, window: 1000, total: 120 });
    // 本轮起点在 turn-start(彼时 total=0),所以增量即累计值。
    expect(state.turnTokens).toBe(120);
    state = reduceTimeline(
      state,
      { type: 'step-end', usage: { inputTokens: 150, outputTokens: 30, totalTokens: 180, cumulativeTotalTokens: 180, contextWindow: 1000 } },
      makeCtx(),
    );
    expect(state.turnTokens).toBe(180);
  });

  it('goal 循环:goal-start 落 notice、turn-end 时目标仍活跃则状态行不熄', () => {
    const goalCtx = makeCtx({ isGoalBusy: () => true, isGoalActive: () => true });
    const state = drain(
      [
        { type: 'turn-start', userText: 'x' },
        { type: 'goal-start', condition: '测试通过', restored: false },
        {
          type: 'turn-end',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cumulativeTotalTokens: 2, contextWindow: 1000 },
          finishReason: 'stop',
        },
      ],
      goalCtx,
    );
    expect(kinds(state)).toEqual(['user', 'notice', 'turn']);
    expect(state.goalActive).toBe(true);
    expect(state.work?.phase).toBe('thinking'); // 没被 turn-end 熄掉
  });

  it('goal-stop 落对应文案的 notice 并清 goalActive', () => {
    const state = drain([
      { type: 'goal-stop', reason: 'met', condition: '测试通过', detail: '', turns: 3, elapsedMs: 65000, tokens: 9000 },
    ]);
    const notice = state.items[0] as { kind: 'notice'; level: string; message: string };
    expect(notice.level).toBe('info');
    expect(notice.message).toContain('3 轮');
    expect(state.goalActive).toBe(false);
  });

  it('compaction-progress 推进压缩进度,compaction 收尾', () => {
    let state = drain([{ type: 'compaction-progress', chars: 1500 }]);
    expect(state.work).toMatchObject({ phase: 'compacting', progress: 0.5 });
    state = reduceTimeline(
      state,
      { type: 'compaction', removedMessages: 20, summaryChars: 3000 },
      makeCtx({ isAgentRunning: () => false }),
    );
    expect(state.work).toBeUndefined();
    expect(state.items.at(-1)?.kind).toBe('notice');
  });

  it('计划模式下整轮未提交方案:turn-end 落 warn 提示', () => {
    const planCtx = makeCtx({ getConfig: () => ({ plan: true, goalMaxTurns: 10 }) });
    const state = drain(
      [
        { type: 'turn-start', userText: '调研一下' },
        { type: 'text-delta', id: 't1', text: '结论……' },
        { type: 'text-end', id: 't1' },
        { type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cumulativeTotalTokens: 2, contextWindow: 1000 }, finishReason: 'stop' },
      ],
      planCtx,
    );
    const notices = state.items.filter((item) => item.kind === 'notice') as { level: string }[];
    expect(notices.some((n) => n.level === 'warn')).toBe(true);
  });

  it('exit_plan 调用过就不落未提交警告', () => {
    const planCtx = makeCtx({ getConfig: () => ({ plan: true, goalMaxTurns: 10 }) });
    const state = drain(
      [
        { type: 'turn-start', userText: 'x' },
        { type: 'tool-start', callId: 'c1', toolName: 'exit_plan', input: { plan: '# 方案' } },
        { type: 'tool-end', callId: 'c1', toolName: 'exit_plan', summary: 'plan', output: {}, isError: false, durationMs: 5 },
        { type: 'turn-end', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cumulativeTotalTokens: 2, contextWindow: 1000 }, finishReason: 'stop' },
      ],
      planCtx,
    );
    expect(state.items.filter((item) => item.kind === 'notice')).toHaveLength(0);
  });

  it('reasoning 流定稿为一行条目(正文保留,可展开)', () => {
    const state = drain([
      { type: 'turn-start', userText: 'x' },
      { type: 'reasoning-delta', id: 'r1', text: '思考中' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-delta', id: 't1', text: '回答' },
      { type: 'text-end', id: 't1' },
    ]);
    const reasoning = state.items.find((item) => item.kind === 'reasoning') as { text: string };
    expect(reasoning.text).toBe('思考中');
    expect(state.activeReasoning).toBe('');
  });

  it('notice 事件原样落条目', () => {
    const state = drain([{ type: 'notice', level: 'warn', message: '自定义提示' }]);
    expect(state.items[0]).toMatchObject({ kind: 'notice', level: 'warn', message: '自定义提示' });
  });

  it('条目 key 全局唯一(reducer 与 nextKey 共用计数器)', () => {
    const state = drain([
      { type: 'turn-start', userText: 'a' },
      { type: 'turn-start', userText: 'b' },
    ]);
    const keys = state.items.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(nextKey()).not.toBe(keys[0]);
  });
});
