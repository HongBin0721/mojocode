/**
 * AgentEvent → 时间线状态的纯 reducer:src/ui/timeline-controller.ts(Solid
 * 信号状态机)的移植,事件分支 1:1 对照——TUI 与 GUI 的时间线语义必须一致
 * (M2 验收:并排跑同一轮对话,两边语义一致)。
 *
 * 与 Solid 版的差异只有三处,均为环境性:
 *  - 私有可变状态(轮起点、思考起点、toolInputs…)从闭包变量变为 state 的
 *    显式字段(纯函数不能藏状态);
 *  - 对 session 的同步读取(config.plan、goal.busy、agent.isRunning…)经
 *    ctx 回调注入(renderer 从 state 快照取);
 *  - onPermissionRequest/onPermissionChange 仍走 ctx 回调(弹窗与权限镜像
 *    归 App 层所有,与 TUI 同构)。
 *
 * 随迁的三个小依赖(splitCommitted、formatDuration/formatTokens、
 * COMPACT_EXPECTED_SUMMARY_CHARS)是从根仓库复制的纯逻辑,各自的注释里
 * 标注了同步义务——上游改动时要跟。
 */

import type {
  AgentEvent,
  ContextUsage,
  GoalStopReason,
  PermissionRequest,
} from '@core/events';
import type { Permissions } from '@core/schema';
import type { ActiveToolCall, TimelineItem } from '@core/types';
import { formatDuration, formatTokens } from '../utils/format.js';
import { t, type MessageKey } from '../i18n/index.js';

/** 进行中的工作状态(类型复制自 src/ui/StatusLine.tsx——那是 Solid 组件文件)。 */
export type WorkPhase =
  | 'thinking'
  | 'responding'
  | 'evaluating'
  | 'tool'
  | 'waiting'
  | 'compacting'
  | 'listingModels';

export interface WorkState {
  phase: WorkPhase;
  /** 附加信息(目前只有工具名)。 */
  detail?: string;
  /** 进度(0–1),目前只有压缩用;收尾事件到达即熄灯,永不自走满格。 */
  progress?: number;
  since: number;
}

/** 进行中的子 agent(task 工具)的单条进度。 */
export interface TaskProgressEntry {
  steps: number;
  tokens: number;
  currentTool?: string;
  recentCalls?: Array<{ toolName: string; input: unknown }>;
}

/** UI 侧的上下文用量镜像(used/window 来自 provider 或估算,total 为会话累计)。 */
export interface UsageMirror {
  used: number;
  window: number;
  total: number;
}

/** reducer 对外界的全部读取与副作用(测试注入假实现,App 注入快照读取)。 */
export interface TimelineCtx {
  /** turn-end 收尾行里显示的模型名。 */
  getModel(): string;
  /** 事件分支要读的两项配置(plan 标志 / goal 轮数上限)。 */
  getConfig(): { plan: boolean; goalMaxTurns: number };
  isGoalBusy(): boolean;
  isGoalActive(): boolean;
  isAgentRunning(): boolean;
  /** 权限询问到达:App 弹审批卡。 */
  onPermissionRequest(request: PermissionRequest): void;
  /** 权限两轴 + plan 被 exit_plan 等工具侧切换:App 同步自己的镜像。 */
  onPermissionChange(permissions: Permissions, plan: boolean): void;
}

export interface TimelineState {
  items: TimelineItem[];
  activeText: string;
  activeReasoning: string;
  activeTools: ActiveToolCall[];
  taskProgress: Record<string, TaskProgressEntry>;
  /** undefined 表示空闲(状态行隐藏)。since 在整轮工作中保持不变。 */
  work: WorkState | undefined;
  usage: UsageMirror;
  /** 当前流式文本块是否已有段落提前定稿(增量提交):渲染前缀要跟着变。 */
  textCommitted: boolean;
  /** 本轮到此刻的 token 增量,给状态行。 */
  turnTokens: number;
  // ---- 事件分支互访的私有字段(纯化后的"闭包变量") ----
  /** 本段思考的起始时刻;undefined 表示没有进行中的思考块。 */
  reasoningStartedAt: number | undefined;
  /** 本轮起点;0 = 没见过本轮 turn-start(--attach 半途接入)。 */
  turnStartedAt: number;
  turnStartTokens: number;
  /** tool-start 记下输入,tool-end 不带输入。 */
  toolInputs: Record<string, unknown>;
  /** 本轮是否调用过 exit_plan。 */
  planSubmitted: boolean;
  /** 本轮**开始时**是否就在计划模式(中途切进来的轮不追问方案)。 */
  planAtTurnStart: boolean;
  goalActive: boolean;
}

let itemCounter = 0;
/** 时间线条目 key 的唯一来源(replay 条目与 reducer 共用同一计数器)。 */
export const nextKey = (): string => `item-${itemCounter++}`;

export function initialTimelineState(contextUsage: ContextUsage | undefined): TimelineState {
  return {
    items: [],
    activeText: '',
    activeReasoning: '',
    activeTools: [],
    taskProgress: {},
    work: undefined,
    // --attach 到跑到一半的 server 时立即有读数,而不是等下一个 step-end。
    usage: { used: contextUsage?.used ?? 0, window: contextUsage?.window ?? 0, total: 0 },
    textCommitted: false,
    turnTokens: 0,
    reasoningStartedAt: undefined,
    turnStartedAt: 0,
    turnStartTokens: 0,
    toolInputs: {},
    planSubmitted: false,
    planAtTurnStart: false,
    goalActive: false,
  };
}

/** goal-stop 的原因 → 文案(穷尽 Record:新增停止原因时编译期就会提醒补文案)。 */
const GOAL_STOP_MESSAGES: Record<GoalStopReason, MessageKey> = {
  met: 'notice.goalStopMet',
  cleared: 'notice.goalStopCleared',
  replaced: 'notice.goalStopReplaced',
  'max-turns': 'notice.goalStopMaxTurns',
  aborted: 'notice.goalStopAborted',
  error: 'notice.goalStopError',
  'check-failed': 'notice.goalStopCheckFailed',
  'plan-mode': 'notice.goalStopPlanMode',
};

/** 复制自 src/ui/commands/registry.ts(那边 import 了整个命令系统,进不了 renderer)。 */
const COMPACT_EXPECTED_SUMMARY_CHARS = 3000;

const FENCE_RE = /^\s*```/;
const LIST_RE = /^(?:\s*(?:[-*+]|\d+[.)])\s|\s+\S)/;

/**
 * 把流式累积的文本切成「可提交定稿的完整段落」和「仍在生成的尾部」。
 * 复制自 src/ui/preview.ts 的 splitCommitted(那文件还带 wrap-ansi 的终端
 * 折行逻辑,GUI 不用);语义改动要与上游同步。
 */
export function splitCommitted(text: string): { committed: string; rest: string } {
  const lines = text.split('\n');
  const isBlank = (i: number) => lines[i]!.trim() === '';

  let fence = false;
  let offset = 0;
  let cut = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) fence = !fence;
    offset += line.length + 1; // 计入换行符
    // 最后一行之后没有内容,段落是否完结未知,不能作为切点。
    if (fence || i >= lines.length - 1 || !isBlank(i)) continue;

    let prev = i - 1;
    while (prev >= 0 && isBlank(prev)) prev--;
    if (prev >= 0 && LIST_RE.test(lines[prev]!)) {
      let next = i + 1;
      while (next < lines.length && isBlank(next)) next++;
      // 末行仍在流式接收中,可能才收到 `2` 而 `. ` 尚未到达——此时判断不出
      // 它是不是列表项,只能保守地不切。列表后面出现完整的非列表行时才提交。
      if (next >= lines.length - 1 || LIST_RE.test(lines[next]!)) continue;
    }

    cut = offset;
  }
  if (cut === 0) return { committed: '', rest: text };
  return { committed: text.slice(0, cut).trimEnd(), rest: text.slice(cut) };
}

/** 阶段切换保留 since(已用时连续);空闲时进入新阶段则从现在起计时。 */
function beginWork(state: TimelineState, phase: WorkPhase, detail?: string): void {
  state.work = { phase, detail, since: state.work?.since ?? Date.now() };
}

function endWork(state: TimelineState): void {
  state.work = undefined;
}

function flushText(state: TimelineState): void {
  const text = state.activeText;
  state.activeText = '';
  if (text.trim()) {
    state.items = [
      ...state.items,
      { key: nextKey(), kind: 'assistant', text: text.trimEnd(), continuation: state.textCommitted },
    ];
  }
  state.textCommitted = false;
}

// 定稿的只是一行"已思考 8.2s":正文在流式期间实时可见,整段进时间线
// 只会淹没回复和工具记录。
function flushReasoning(state: TimelineState): void {
  const text = state.activeReasoning;
  const startedAt = state.reasoningStartedAt;
  state.reasoningStartedAt = undefined;
  state.activeReasoning = '';
  if (text.trim()) {
    state.items = [
      ...state.items,
      {
        key: nextKey(),
        kind: 'reasoning',
        durationMs: startedAt ? Date.now() - startedAt : undefined,
        text,
      },
    ];
  }
}

// 中断和流级异常不会给进行中的文本块补发 text-end/reasoning-end,已生成的
// 部分必须在这里定稿,否则永远进不了时间线,还会残留在累积区、被拼进下一轮。
function flushInterrupted(state: TimelineState): void {
  flushReasoning(state);
  flushText(state);
  state.activeTools = [];
  state.taskProgress = {};
}

export function reduceTimeline(
  prev: TimelineState,
  event: AgentEvent,
  ctx: TimelineCtx,
): TimelineState {
  // 拷贝顶层后局部可变:分支内部像 Solid 版一样直写,结束一次性返回新引用。
  const state: TimelineState = { ...prev, items: prev.items, toolInputs: { ...prev.toolInputs } };

  switch (event.type) {
    case 'turn-start':
      state.items = [...state.items, { key: nextKey(), kind: 'user', text: event.display ?? event.userText }];
      state.planSubmitted = false;
      state.planAtTurnStart = ctx.getConfig().plan;
      state.turnStartedAt = Date.now();
      state.turnStartTokens = state.usage.total;
      // 新一轮从零开始计时,不沿用上一轮残留的 since。
      state.work = { phase: 'thinking', since: Date.now() };
      break;

    case 'text-delta': {
      const combined = state.activeText + event.text;
      // 段落级增量提交:空行收尾的段落立即定稿为不可变条目,正在生成的尾段
      // 作为活动条目在时间线尾部原地生长——可变区始终只有一小段。
      const { committed, rest } = splitCommitted(combined);
      if (committed) {
        state.items = [
          ...state.items,
          { key: nextKey(), kind: 'assistant', text: committed, continuation: state.textCommitted },
        ];
        state.textCommitted = true;
        state.activeText = rest;
      } else {
        state.activeText = combined;
      }
      beginWork(state, 'responding');
      break;
    }
    case 'text-end':
      flushText(state);
      break;

    case 'reasoning-delta':
      // 计时从第一个增量起:reasoning-start 未必所有 provider 都发。
      state.reasoningStartedAt ??= Date.now();
      state.activeReasoning += event.text;
      beginWork(state, 'thinking');
      break;
    case 'reasoning-end':
      flushReasoning(state);
      break;

    case 'tool-start':
      if (event.toolName === 'exit_plan') state.planSubmitted = true;
      state.toolInputs[event.callId] = event.input;
      state.activeTools = [
        ...state.activeTools,
        { callId: event.callId, toolName: event.toolName, input: event.input, startedAt: Date.now() },
      ];
      beginWork(state, 'tool', event.toolName);
      break;

    case 'tool-end': {
      state.activeTools = state.activeTools.filter((call) => call.callId !== event.callId);
      if (event.callId in state.taskProgress) {
        const { [event.callId]: _gone, ...rest } = state.taskProgress;
        state.taskProgress = rest;
      }
      const input = state.toolInputs[event.callId];
      delete state.toolInputs[event.callId];
      state.items = [
        ...state.items,
        {
          key: nextKey(),
          kind: 'tool',
          toolName: event.toolName,
          input,
          summary: event.summary,
          output: event.output,
          isError: event.isError,
          durationMs: event.durationMs,
        },
      ];
      beginWork(state, 'thinking');
      break;
    }

    case 'task-progress':
      state.taskProgress = {
        ...state.taskProgress,
        [event.callId]: {
          steps: event.steps,
          tokens: event.tokens,
          currentTool: event.currentTool,
          recentCalls: event.recentCalls,
        },
      };
      break;

    case 'permission-request':
      ctx.onPermissionRequest(event.request);
      beginWork(state, 'waiting');
      break;

    // 权限也可能由 exit_plan 在工具侧切换(方案获批),不订阅的话顶栏
    // 会一直停在 plan。
    case 'permission-change':
      ctx.onPermissionChange(event.permissions, event.plan);
      break;

    case 'step-end':
      state.usage = {
        used: event.usage.inputTokens,
        window: event.usage.contextWindow,
        total: event.usage.cumulativeTotalTokens,
      };
      break;

    case 'turn-end':
      state.usage = { ...state.usage, total: event.usage.cumulativeTotalTokens };
      // 计划模式下这一轮没提交过方案:门禁保证了什么都没改,但"我明明用了
      // /plan,它却没问我"必须看得见,不能静悄悄。
      if (state.planAtTurnStart && ctx.getConfig().plan && !state.planSubmitted) {
        state.items = [
          ...state.items,
          { key: nextKey(), kind: 'notice', level: 'warn', message: t('notice.planNoSubmission') },
        ];
      }
      // 一轮的收尾行(模型 · 耗时 · 本轮 token)。中断与出错各自走自己的
      // 分支(没有可信的用量),不画这一行。没见过本轮的 turn-start 就不画:
      // 那时基准是 0,整个会话的累计量会被当成这一轮的开销报出来。
      if (state.turnStartedAt) {
        state.items = [
          ...state.items,
          {
            key: nextKey(),
            kind: 'turn',
            model: ctx.getModel(),
            durationMs: Date.now() - state.turnStartedAt,
            tokens: Math.max(0, event.usage.cumulativeTotalTokens - state.turnStartTokens),
            inputTokens: event.usage.inputTokens,
            cachedTokens: event.usage.cachedInputTokens,
          },
        ];
        // 基准一次性消费:漏收的那轮不该借用上一轮的起点。
        state.turnStartedAt = 0;
      }
      // 目标循环**还会接着跑**时留着状态行,交给紧随其后的 goal-evaluating
      // 接手;在这里熄灯的话,自动循环会每两轮闪一次"已空闲"。
      if (!(ctx.isGoalBusy() && ctx.isGoalActive())) endWork(state);
      break;

    case 'goal-start':
      state.goalActive = true;
      state.items = [
        ...state.items,
        {
          key: nextKey(),
          kind: 'notice',
          level: 'info',
          message: event.restored
            ? t('notice.goalRestored', { condition: event.condition })
            : t('notice.goalSet', {
                condition: event.condition,
                max: ctx.getConfig().goalMaxTurns,
              }),
        },
      ];
      break;

    case 'goal-evaluating':
      beginWork(state, 'evaluating');
      break;

    case 'goal-verdict':
      // 达成时的收尾文案由 goal-stop 给,这里不重复推第二条。
      if (!event.met) {
        state.items = [
          ...state.items,
          {
            key: nextKey(),
            kind: 'notice',
            level: 'info',
            message: t('notice.goalNotMet', {
              reason: event.reason,
              turn: event.turn,
              max: event.maxTurns,
            }),
          },
        ];
      }
      break;

    case 'goal-stop':
      // replaced 后面紧跟着新目标的 goal-start,顺序保证了不会误熄。
      state.goalActive = false;
      state.items = [
        ...state.items,
        {
          key: nextKey(),
          kind: 'notice',
          level: event.reason === 'met' ? 'info' : 'warn',
          // 八条文案共用一个参数袋:t() 忽略多余参数,各条只取自己关心的。
          message: t(GOAL_STOP_MESSAGES[event.reason], {
            condition: event.condition,
            detail: event.detail,
            turns: event.turns,
            elapsed: formatDuration(event.elapsedMs),
            tokens: formatTokens(event.tokens),
          }),
        },
      ];
      // `/goal clear` 可能是在一轮进行中发出的:那一轮还在流,别把状态行掐了。
      if (!ctx.isAgentRunning()) endWork(state);
      break;

    // 压缩摘要流式生成中:状态行切到「压缩中」并推进进度条。摘要总长事先
    // 未知,按典型长度估算、封顶 99%——估短了只会让条提前贴住 99%,绝不回退。
    case 'compaction-progress':
      state.work = {
        phase: 'compacting',
        progress: Math.min(0.99, event.chars / COMPACT_EXPECTED_SUMMARY_CHARS),
        since: state.work?.since ?? Date.now(),
      };
      break;

    case 'compaction':
      state.items = [
        ...state.items,
        {
          key: nextKey(),
          kind: 'notice',
          level: 'info',
          message: t('notice.compacted', { removed: event.removedMessages, chars: event.summaryChars }),
        },
      ];
      // 压缩收尾:自动压缩发生在一轮进行中,把状态还给「思考中」;手动压缩
      // (空闲)直接熄灯。压缩失败没有这条事件,状态由错误 notice 之后的流
      // 事件自愈。
      if (state.work?.phase === 'compacting') {
        state.work = ctx.isAgentRunning() ? { phase: 'thinking', since: state.work.since } : undefined;
      }
      break;

    case 'notice':
      state.items = [...state.items, { key: nextKey(), kind: 'notice', level: event.level, message: event.message }];
      break;

    case 'error':
      flushInterrupted(state);
      state.items = [...state.items, { key: nextKey(), kind: 'error', message: event.error.message }];
      endWork(state);
      break;

    case 'aborted':
      flushInterrupted(state);
      state.items = [...state.items, { key: nextKey(), kind: 'notice', level: 'warn', message: t('notice.interrupted') }];
      endWork(state);
      break;

    default:
      break;
  }

  // turnTokens 是派生量,每个事件后统一重算(Solid 版是 memo)。
  state.turnTokens = state.turnStartedAt
    ? Math.max(0, state.usage.total - state.turnStartTokens)
    : 0;
  return state;
}
