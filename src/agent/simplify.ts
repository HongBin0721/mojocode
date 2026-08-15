/**
 * `/simplify` 命令的服务端核心:目标解析、两阶段清理提示词组稿与阶段一
 * 编排(对齐 Claude Code 的多 agent 形态)。阶段一:四个只读 explore 子代理
 * **并行**、每轴一整份专属上下文(复用/化简/效率/抽象层级),只报告不动手;
 * 阶段二:主对话拿到全部报告,去重合并后核实、应用修复(保持未提交)。
 * 正确性 bug 不在本命令职责内——那是 /review 一轮的事。
 *
 * 范围收集、失败 reason、安全前缀命令全部复用 review.ts;子代理的执行通道
 * 是 task.ts 的 runTaskSubagent(独立步数预算、过程落盘),由 bootstrap
 * 注入 runAxisReviews;模块级测试在 tests/simplify.test.ts。
 */

import {
  ARG_SCOPE_KEYWORDS,
  parseReviewArg,
  scopeBlock,
  type ReviewScope,
  type ReviewSummary,
  type ReviewStartResult,
} from './review.js';
import type { EventBus } from '../core/events.js';
import { summarizeToolResult } from '../tools/index.js';
import type { RunTaskOptions, TaskRunResult } from '../tools/task.js';

/** 与 /review 共用的启动结果形状(失败 reason 语义一致),别名以免误读。 */
export type SimplifyStartResult = ReviewStartResult;

/** 一个清理轴:label 给人看(选择器/进度),focus 是该轴子代理的专属指令。 */
export interface SimplifyAxis {
  id: 'reuse' | 'simplification' | 'efficiency' | 'abstraction';
  label: string;
  focus: string;
}

/**
 * 四个清理轴。每份 focus 写成"怎么查"的可执行步骤而非形容词——子代理
 * 看不到本会话任何上下文,指令必须自含。轴间互斥由 axis prompt 的排他条款
 * 保证,这里不需要额外机制。
 */
export const SIMPLIFY_AXES: SimplifyAxis[] = [
  {
    id: 'reuse',
    label: 'Reuse',
    focus: `Your axis is REUSE of existing code. Find places where the changed code
reimplements something this repository already provides — helpers, utils,
constants, established patterns, error message wording. Search the WHOLE
repository (glob/grep by concept and by naming conventions), not just the
files in the diff. For each duplicate, name the existing symbol to reuse and
the file where it lives.`,
  },
  {
    id: 'simplification',
    label: 'Simplification',
    focus: `Your axis is NEEDLESS COMPLEXITY introduced by the change: dead code,
redundant branches or checks, unused parameters or variables, conditions that
are always true/false, over-general abstractions with a single caller. Read
the callers of anything you propose to collapse — a "single caller" today may
be an intentional extension point; check before flagging.`,
  },
  {
    id: 'efficiency',
    label: 'Efficiency',
    focus: `Your axis is AVOIDABLE REPEATED WORK in the changed code: extra passes
over data, re-reading files that were already read, redundant allocations or
computations, O(n²) where O(n) suffices. Flag only what plausibly matters at
realistic sizes; skip micro-optimizations that do not change the shape of the
work. Cite the concrete repeated cost, not a vague "could be faster".`,
  },
  {
    id: 'abstraction',
    label: 'Abstraction level',
    focus: `Your axis is ABSTRACTION LEVEL: logic sitting at the wrong layer or
duplicated across layers after this change — helpers defined far from their
only caller, the same rule implemented in two layers, UI code doing core
logic or core code formatting for the UI. Judge by this repository's existing
layering conventions (read neighboring files to learn them), not by textbook
rules.`,
  },
];

/**
 * 解析 `/simplify <arg>` 的参数。与 parseReviewArg 的差异:
 *  - 裸命令合法:默认未提交改动(Claude Code 的默认目标就是当前 diff);
 *  - 认不出的非空文本不算失败,而是当作清理目标(路径或焦点),挂到
 *    uncommitted 摘要上——对齐 Claude Code 的 `/simplify <path>`。
 * 半截关键字(base/commit/custom 裸打)返回 undefined,交回 UI 给用法提示。
 */
export function parseSimplifyArg(arg: string): ReviewScope | undefined {
  const trimmed = arg.trim();
  if (!trimmed) return { kind: 'uncommitted' };
  if (ARG_SCOPE_KEYWORDS.includes(trimmed)) return undefined;
  // 形状非法的 git token(a..b、-x 之类)到不了 git:只会作为目标文本嵌进
  // 提示词,没有注入面;真分支/真 sha 仍由 collectReviewSummary 校验。
  return parseReviewArg(trimmed) ?? { kind: 'custom', instructions: trimmed };
}

/** custom 范围下用户目标文本的引导句(review 用的是"评审焦点"措辞)。 */
const CUSTOM_TARGET_HEADER = 'Cleanup target requested by the user — restrict the pass to it:';

/**
 * 阶段一:单轴审查子代理的完整任务书(英文——喂给模型的文本按约定不本地化)。
 * 子代理看不到会话上下文,范围块、纪律条款、产出格式必须全部自含;explore
 * 模式只发只读工具,报告而非修复——应用在阶段二由主对话完成。
 */
export function buildSimplifyAxisPrompt(axis: SimplifyAxis, scope: ReviewScope, summary: ReviewSummary): string {
  return `You are one of four parallel cleanup reviewers. Each reviewer owns exactly
one axis; the others cover reuse, simplification, efficiency and abstraction.
Everything outside YOUR axis is someone else's job — ignore it, even if obvious.

${axis.focus}

Scope of the change under review:

${scopeBlock(scope, summary, { customFocusHeader: CUSTOM_TARGET_HEADER })}

Discipline:

- You have no shell in this mode and cannot run the git commands listed in
  the scope block — the apply pass fetches the full diff later. Locate the
  change from the summary's file list and stats, then read the current
  content of those sites directly, along with their callers and neighbors —
  a single file rarely shows whether code is redundant or misplaced.
- The working tree is the ground truth, not the diff: when the scope is a
  commit or a base range (a historical diff), re-check each site against the
  current file content, and report drift as drift instead of findings against
  stale lines.
- You are read-only and your report is your only output: do not attempt fixes,
  do not propose correctness changes — a separate review pass covers bugs.

Report format — numbered findings, most valuable first:

1. path/to/file.ts:42 — what is redundant or misplaced, the smallest concrete
   cleanup, confidence (high|medium|low).

Cite only file:line references you actually read. If the change is clean
along your axis, say exactly that; do not invent findings to justify the pass.`;
}

/** 阶段二收到的单轴结果:成功(可带 incomplete 标记)或子代理直接失败。 */
export type AxisReport = { ok: true; report: string; incomplete?: string } | { ok: false; error: string };

/**
 * 把一轴结果渲染成应用轮提示词里的一节。失败轴保留位置并明说覆盖不全,
 * 应用轮据此在总结里交代,而不是默默少审一个维度。
 */
export function axisSection(axis: SimplifyAxis, outcome: AxisReport): string {
  if (!outcome.ok) {
    return `### ${axis.label}\n\n(The ${axis.label.toLowerCase()} reviewer failed: ${outcome.error}\nThis axis was NOT covered — say so in your final summary.)`;
  }
  const warning = outcome.incomplete ? `\n\n(Note: ${outcome.incomplete})` : '';
  return `### ${axis.label}\n\n${outcome.report}${warning}`;
}

/**
 * 阶段一编排:四轴并行审查,并给主总线发**合成的 task 工具事件**。子代理的
 * task-progress 只能贴在「在途 task 工具行」上渲染(App 的 activeTools,行
 * 的 callId 由 tool-start 建立)——罐装通道没有真实的工具调用,不发这几条,
 * 整个阶段一在 UI 里就只剩一条 info 提示,几分钟零可见活动。收尾的 tool-end
 * 让动态行收掉、时间线各留一条定稿(失败轴 isError);报告全文照旧由
 * runTaskSubagent 的 onTranscript 随会话落盘。返回应用轮要用的各轴小节。
 */
export async function runAxisReviews(
  scope: ReviewScope,
  summary: ReviewSummary,
  deps: { bus: EventBus; run: (opts: RunTaskOptions) => Promise<TaskRunResult> },
): Promise<string[]> {
  const axes = SIMPLIFY_AXES.map((axis) => ({
    axis,
    callId: `simplify-${axis.id}`,
    description: `Simplify: ${axis.label}`,
    prompt: buildSimplifyAxisPrompt(axis, scope, summary),
  }));
  // 先把四行宿主立起来再起子代理:进度事件到达时行必须已经在场。
  for (const { callId, description, prompt } of axes) {
    deps.bus.emit({
      type: 'tool-start',
      callId,
      toolName: 'task',
      input: { description, prompt, mode: 'explore' },
    });
  }
  const startedAt = Date.now();
  const settled = await Promise.allSettled(
    axes.map(({ callId, description, prompt }) =>
      deps.run({ description, prompt, mode: 'explore', toolCallId: callId }),
    ),
  );
  const finishedAt = Date.now();
  settled.forEach((result, index) => {
    const { callId } = axes[index]!;
    if (result.status === 'fulfilled') {
      deps.bus.emit({
        type: 'tool-end',
        callId,
        toolName: 'task',
        summary: summarizeToolResult('task', result.value),
        output: result.value,
        isError: false,
        durationMs: finishedAt - startedAt,
      });
      return;
    }
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    deps.bus.emit({
      type: 'tool-end',
      callId,
      toolName: 'task',
      summary: message.split('\n')[0]!.slice(0, 120),
      output: message,
      isError: true,
      durationMs: finishedAt - startedAt,
    });
  });
  return settled.map((result, index) =>
    axisSection(
      axes[index]!.axis,
      result.status === 'fulfilled'
        ? { ok: true, report: result.value.result, incomplete: result.value.incomplete }
        : {
            ok: false,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          },
    ),
  );
}

/**
 * 阶段二:主对话应用轮的提示词。四份报告去重合并后核实、应用,保持未提交;
 * 行为必须保持,拿不准的发现跳过并说明。工作区是基准——历史范围的 diff
 * 与现状漂移处不硬套。
 */
export function buildSimplifyApplyPrompt(
  scope: ReviewScope,
  summary: ReviewSummary,
  sections: string[],
): string {
  return `Four parallel reviewers each examined the change below along one axis
and reported findings. Merge their reports and apply the cleanups yourself.

## Scope

${scopeBlock(scope, summary, { customFocusHeader: CUSTOM_TARGET_HEADER })}

## Reviewer reports

${sections.join('\n\n')}

## How to apply

- Merge and de-duplicate first: the same site may appear in several reports;
  plan one edit per site instead of applying the same cleanup twice.
- Verify every finding against the CURRENT file content before editing — the
  working tree is the ground truth, not the diff. Where the code has drifted
  since the reviewed diff, skip the site and mention the drift.
- Discard findings you judge wrong or risky. Behavior must be preserved: if a
  cleanup could plausibly change behavior, skip it and say why.
- Edit only code this change touches; keep every edit minimal.
- Apply fixes by editing the working tree and leave them uncommitted for the
  user to review: no git commit, stash, checkout, rebase or branch, and do
  NOT call exit_plan.
- If AGENTS.md or the README lists a typecheck or test command, run it on
  what you touched and report the outcome.

## Output

Per axis, one short paragraph: what you changed and why (file:line), what you
skipped and why, or that it was clean. End with the typecheck/test outcome.
Do not invent work to justify the pass.`;
}
