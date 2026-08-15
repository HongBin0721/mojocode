import { describe, expect, it } from 'vitest';
import {
  parseSimplifyArg,
  SIMPLIFY_AXES,
  buildSimplifyAxisPrompt,
  buildSimplifyApplyPrompt,
  axisSection,
  runAxisReviews,
} from '../src/agent/simplify.js';
import type { ReviewSummary } from '../src/agent/review.js';
import { EventBus, type AgentEvent } from '../src/core/events.js';

describe('parseSimplifyArg', () => {
  it('裸命令与空白默认未提交改动(Claude Code 的默认目标)', () => {
    expect(parseSimplifyArg('')).toEqual({ kind: 'uncommitted' });
    expect(parseSimplifyArg('   ')).toEqual({ kind: 'uncommitted' });
  });

  it('范围语法与 /review 共享:uncommitted/base/commit/custom 原样透传', () => {
    expect(parseSimplifyArg('uncommitted')).toEqual({ kind: 'uncommitted' });
    expect(parseSimplifyArg('base main')).toEqual({ kind: 'base', branch: 'main' });
    expect(parseSimplifyArg('commit ABCDEF1234567')).toEqual({
      kind: 'commit',
      sha: 'abcdef1234567',
    });
    expect(parseSimplifyArg('custom 关注并发')).toEqual({ kind: 'custom', instructions: '关注并发' });
  });

  it('认不出的非空文本是清理目标(路径或焦点),挂到 custom 范围', () => {
    expect(parseSimplifyArg('src/foo.ts')).toEqual({
      kind: 'custom',
      instructions: 'src/foo.ts',
    });
    // 形状非法的 git token 到不了 git,只会作为目标文本嵌进提示词(无注入面)。
    expect(parseSimplifyArg('base a..b')).toEqual({ kind: 'custom', instructions: 'base a..b' });
  });

  it('半截关键字(base/commit/custom 裸打)不成目标,交回 UI 给用法提示', () => {
    expect(parseSimplifyArg('base')).toBeUndefined();
    expect(parseSimplifyArg('commit')).toBeUndefined();
    expect(parseSimplifyArg('custom')).toBeUndefined();
  });
});

describe('buildSimplifyAxisPrompt(阶段一:单轴审查子代理)', () => {
  const summary: ReviewSummary = {
    currentBranch: 'main',
    logLines: [],
    statLines: [' a.txt | 1 +'],
    statusLines: [' M a.txt', '?? u.txt'],
    truncated: {},
  };

  it('四轴各领一份互斥的专属指令,编号与标题一一对应', () => {
    expect(SIMPLIFY_AXES.map((a) => a.id)).toEqual([
      'reuse',
      'simplification',
      'efficiency',
      'abstraction',
    ]);
    for (const axis of SIMPLIFY_AXES) {
      const prompt = buildSimplifyAxisPrompt(axis, { kind: 'uncommitted' }, summary);
      // 自家的轴指令在场,别家的不在——互斥是提示词层面的约定,得可断言。
      expect(prompt).toContain(axis.focus);
      for (const other of SIMPLIFY_AXES) {
        if (other.id !== axis.id) expect(prompt).not.toContain(other.focus);
      }
    }
  });

  it('只读纪律与报告格式自含:不修复、不找 bug、以工作区为基准、按 file:line 编号', () => {
    const prompt = buildSimplifyAxisPrompt(SIMPLIFY_AXES[0]!, { kind: 'uncommitted' }, summary);
    expect(prompt).toContain('four parallel cleanup reviewers');
    expect(prompt).toContain('do not attempt fixes');
    expect(prompt).toContain('a separate review pass covers bugs');
    expect(prompt).toContain('The working tree is the ground truth, not the diff');
    expect(prompt).toContain('confidence (high|medium|low)');
    expect(prompt).toContain('do not invent findings');
    // explore 工具集没有 shell:纪律必须自洽——不能叫子代理去跑 scope block
    // 里列的 git 命令(那是应用轮的事),它只能按摘要的文件清单读代码。
    expect(prompt).toContain('cannot run the git commands');
    expect(prompt).not.toContain('Fetch the full diff yourself');
  });

  it('范围块复用 review 的组稿:porcelain、安全前缀命令与 untracked 指引都在', () => {
    const prompt = buildSimplifyAxisPrompt(SIMPLIFY_AXES[1]!, { kind: 'uncommitted' }, summary);
    expect(prompt).toContain(' M a.txt');
    expect(prompt).toContain('?? u.txt');
    expect(prompt).toContain('git diff HEAD -- <path>');
    expect(prompt).toContain('read tool');
  });
});

describe('runAxisReviews(阶段一编排:合成工具事件让进度可见)', () => {
  const summary: ReviewSummary = {
    currentBranch: 'main',
    logLines: [],
    statLines: [' a.txt | 1 +'],
    statusLines: [' M a.txt'],
    truncated: {},
  };

  it('四轴各发 tool-start(先于子代理启动)与 tool-end,失败轴 isError', async () => {
    const events: AgentEvent[] = [];
    const order: string[] = [];
    const bus = new EventBus();
    bus.on((e) => {
      events.push(e);
      if (e.type === 'tool-start') order.push(`start:${e.callId}`);
    });
    const sections = await runAxisReviews({ kind: 'uncommitted' }, summary, {
      bus,
      run: async (opts) => {
        order.push(`run:${opts.toolCallId}`);
        if (opts.toolCallId === 'simplify-efficiency') throw new Error('boom');
        return { result: 'clean along this axis', steps: 3, tokens: 1200 };
      },
    });

    const starts = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool-start' }> => e.type === 'tool-start',
    );
    expect(starts.map((e) => e.callId)).toEqual([
      'simplify-reuse',
      'simplify-simplification',
      'simplify-efficiency',
      'simplify-abstraction',
    ]);
    // 宿主行必须先立起来,子代理的 task-progress 才有处可贴。
    expect(order.slice(0, 4).every((entry) => entry.startsWith('start:'))).toBe(true);
    expect(order).toHaveLength(8); // 4 条 start + 4 次 run

    const ends = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool-end' }> => e.type === 'tool-end',
    );
    expect(ends).toHaveLength(4);
    const failed = ends.find((e) => e.callId === 'simplify-efficiency')!;
    expect(failed.isError).toBe(true);
    expect(failed.summary).toContain('boom');
    for (const end of ends) {
      if (end.callId === 'simplify-efficiency') continue;
      expect(end.isError).toBe(false);
      // 摘要走 task 的规模格式(两种语言目录都以 tokens 计)。
      expect(end.summary).toContain('tokens');
    }
    // 返回的小节与应用轮提示词对接:失败轴明说覆盖不全,成功轴带报告。
    expect(sections).toHaveLength(4);
    expect(sections.join('\n')).toContain('NOT covered');
    expect(sections.join('\n')).toContain('clean along this axis');
  });
});

describe('axisSection / buildSimplifyApplyPrompt(阶段二:汇总应用)', () => {
  const summary: ReviewSummary = {
    currentBranch: 'main',
    logLines: [],
    statLines: [' a.txt | 1 +'],
    statusLines: [],
    truncated: {},
  };

  it('成功的轴原样带报告;incomplete 追加警示;失败的轴明说覆盖不全', () => {
    const ok = axisSection(SIMPLIFY_AXES[0]!, { ok: true, report: '1. a.ts:1 — duplicate' });
    expect(ok).toContain('### Reuse');
    expect(ok).toContain('1. a.ts:1 — duplicate');

    const partial = axisSection(SIMPLIFY_AXES[1]!, {
      ok: true,
      report: 'clean',
      incomplete: 'ran out of its step budget',
    });
    expect(partial).toContain('(Note: ran out of its step budget)');

    const failed = axisSection(SIMPLIFY_AXES[2]!, { ok: false, error: 'interrupted' });
    expect(failed).toContain('### Efficiency');
    expect(failed).toContain('NOT covered');
    expect(failed).toContain('interrupted');
  });

  it('应用轮提示词:四节报告全在,去重/核实/保持未提交/跑门禁的条款都在', () => {
    const sections = SIMPLIFY_AXES.map((axis) =>
      axisSection(axis, { ok: true, report: `${axis.label}: finding` }),
    );
    const prompt = buildSimplifyApplyPrompt({ kind: 'uncommitted' }, summary, sections);
    expect(prompt).toContain('### Reuse');
    expect(prompt).toContain('### Simplification');
    expect(prompt).toContain('### Efficiency');
    expect(prompt).toContain('### Abstraction level');
    expect(prompt).toContain('Merge and de-duplicate');
    expect(prompt).toContain('working tree is the ground truth');
    expect(prompt).toContain('leave them uncommitted');
    expect(prompt).toContain('exit_plan');
    expect(prompt).toContain('typecheck or test command');
    // 阶段一的"只报告不动手"不能带进应用轮——这一轮就是要改文件。
    expect(prompt).not.toContain('do not attempt fixes');
  });

  it('历史范围(commit)同样嵌工作区为基准的条款', () => {
    const prompt = buildSimplifyApplyPrompt(
      { kind: 'commit', sha: 'abcdef1234' },
      summary,
      [axisSection(SIMPLIFY_AXES[0]!, { ok: true, report: 'clean' })],
    );
    expect(prompt).toContain('ground truth');
  });
});
