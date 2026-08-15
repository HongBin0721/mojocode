import { batch, createSignal, onCleanup, type Setter } from 'solid-js';
import type { ActiveToolCall, NewTimelineItem, TimelineItem } from './types.js';
import type { WorkPhase, WorkState } from './StatusLine.js';
import type { AgentEvent, PermissionRequest } from '../core/events.js';
import type { SessionHandle } from '../app/session-handle.js';
import type { Permissions } from '../config/schema.js';
import { permissionsLabel } from '../config/schema.js';
import { COMPACT_EXPECTED_SUMMARY_CHARS, GOAL_STOP_MESSAGES } from './commands/registry.js';
import { formatDuration, formatTokens } from './theme.js';
import { splitCommitted } from './preview.js';
import { replayTimeline } from '../session/replay.js';
import { t } from '../i18n/index.js';

/**
 * AgentEvent → UI 状态的完整状态机(原 App.tsx 的事件 reducer,整段搬运)。
 *
 * 它持有时间线与流式过程的所有信号:items、活动文本/思考/工具行、任务
 * 进度、工作状态行、上下文用量,以及只被事件分支互访的私有可变状态
 * (轮起点、思考起点、toolInputs、planSubmitted…)。App 只通过返回的
 * getter/setter 读写;权限弹窗与权限镜像归 App 所有,经回调上抛。
 *
 * 必须在组件 setup 作用域内**同步**调用(bus 订阅的 onCleanup 要绑到
 * 当时的 owner),不得包进异步或定时器。
 */

let itemCounter = 0;
/** 时间线条目 key 的唯一来源(App 的 bannerItem/回退回放与 controller 共用)。 */
export const nextKey = () => `item-${itemCounter++}`;

/**
 * 启动横幅条目:字段取自 session 的当前值。会话中途 /models、shift+tab
 * 改掉的值走 App 内的 bannerItem(那边读的是 state 镜像)。
 */
export function sessionBanner(session: SessionHandle): TimelineItem {
  const mode = session.config.plan
    ? 'plan'
    : permissionsLabel({ sandbox: session.config.sandbox, approval: session.config.approval });
  const connected = session.mcpStatuses.filter((s) => s.connected).length;
  return {
    key: nextKey(),
    kind: 'banner',
    providerLabel: session.provider.label,
    model: session.provider.model,
    root: session.root,
    mode,
    mcpSummary: session.mcpStatuses.length > 0 ? `${connected}/${session.mcpStatuses.length}` : undefined,
  };
}

/**
 * 恢复会话时的初始时间线:一条 divider + 完整回放。空会话返回空数组。
 * 调用方负责在最前面补横幅(sessionBanner / bannerItem)。
 *
 * 回放读**展示历史**而不是模型历史:压缩把模型历史换成摘要+尾巴,但用户
 * 恢复会话该看到的是原始对话(与 opencode 一致)。`??` 兜底覆盖没有该字段
 * 的旧 server 镜像与测试桩——那时退回模型历史,摘要显示成一行压缩提示。
 */
export function buildResumeItems(session: SessionHandle): TimelineItem[] {
  const messages = session.store.displayMessages ?? session.store.messages;
  if (messages.length === 0) return [];
  const replayed: NewTimelineItem[] = [
    {
      kind: 'divider',
      label: t('divider.resumed', { id: session.store.id.slice(0, 8), n: messages.length }),
    },
    ...replayTimeline(messages),
  ];
  return replayed.map((item) => ({ ...item, key: nextKey() }) as TimelineItem);
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

export interface TimelineControllerOptions {
  /** 权限询问到达:App 弹确认框(并关掉被抢占据的覆盖层)。 */
  onPermissionRequest: (request: PermissionRequest) => void;
  /** 权限两轴 + plan 被 exit_plan 等工具侧切换:App 同步自己的镜像信号。 */
  onPermissionChange: (permissions: Permissions, plan: boolean) => void;
  /** turn-end 收尾行里显示的模型名(App 的镜像信号)。 */
  getModel: () => string;
  /** goal-start/goal-stop:目标行要不要渲染(App 的 goalActive 信号)。 */
  onGoalActiveChange: (active: boolean) => void;
}

export interface TimelineController {
  items: () => TimelineItem[];
  activeText: () => string;
  activeReasoning: () => string;
  activeTools: () => ActiveToolCall[];
  taskProgress: () => Record<string, TaskProgressEntry>;
  work: () => WorkState | undefined;
  usage: () => UsageMirror;
  /** 当前流式文本块是否已有段落提前定稿(增量提交):渲染前缀要跟着变。 */
  textCommitted: () => boolean;
  /** 本轮到此刻的 token 增量,给状态行。 */
  turnTokens: () => number;
  push: (item: NewTimelineItem) => void;
  setItems: Setter<TimelineItem[]>;
  setWork: Setter<WorkState | undefined>;
  endWork: () => void;
  setUsage: Setter<UsageMirror>;
}

export function createTimelineController(
  session: SessionHandle,
  opts: TimelineControllerOptions,
): TimelineController {
  // `mojocode -r` 恢复的会话在首帧就带着回放的历史时间线。
  // 横幅永远是第一条(见 types.ts 的 banner 注释)。
  const [items, setItems] = createSignal<TimelineItem[]>([
    sessionBanner(session),
    ...buildResumeItems(session),
  ]);
  const [activeText, setActiveText] = createSignal('');
  const [activeReasoning, setActiveReasoning] = createSignal('');
  const [activeTools, setActiveTools] = createSignal<ActiveToolCall[]>([]);
  // 进行中的子 agent(task 工具)的进度,按 callId 键。tool-end 时清掉。
  const [taskProgress, setTaskProgress] = createSignal<Record<string, TaskProgressEntry>>({});
  // 工作状态:undefined 表示空闲(状态行隐藏)。since 在整轮工作中保持
  // 不变,阶段切换只更新文字和颜色,已用时连续累计。
  const [work, setWork] = createSignal<WorkState | undefined>(undefined);
  // 挂载初值取 contextUsage(--attach 到跑到一半的 server 时立即有读数,
  // 而不是等下一个 step-end),本地新会话自然是 0。
  const [usage, setUsage] = createSignal<UsageMirror>({ ...session.agent.contextUsage, total: 0 });

  // 本段思考的起始时刻,定稿那一行的耗时由它算出。undefined 表示当前没有
  // 进行中的思考块。
  let reasoningStartedAt: number | undefined;

  // 本轮的起点与起始累计 token,收尾行(kind: 'turn')的耗时与本轮用量由
  // 它们相减得出。累计量取 UI 侧的镜像:turn-start 时它还停在上一轮的终值。
  let turnStartedAt = 0;
  // 信号而非裸 let:状态行要按它实时显示"本轮已烧了多少 token"。
  const [turnStartTokens, setTurnStartTokens] = createSignal(0);
  /**
   * 本轮到此刻的 token 增量,给状态行。每个 step-end 刷新一次 usage,所以
   * 它按步跳而不是按 delta 连续涨——够说明"还在往前走"了。turnStartedAt
   * 为 0(没见过本轮的 turn-start,如 --attach 半途接入)时不报数,免得把
   * 整个会话的累计量当成这一轮的开销。
   */
  const turnTokens = () => (turnStartedAt ? Math.max(0, usage().total - turnStartTokens()) : 0);

  // 当前流式文本块是否已有段落提前定稿(增量提交):后续片段(含时间线里
  // 正在生长的活动条目)渲染时不再带 ● 前缀,只缩进对齐。信号而不是裸变量:
  // 活动条目的前缀表达式要在它翻转时重算,不能指望恰好同批读了 activeText。
  const [textCommitted, setTextCommitted] = createSignal(false);

  // `tool-end` 不携带调用的输入,所以在 `tool-start` 时先记下来。
  const toolInputs = new Map<string, unknown>();

  // 本轮是否调用过 exit_plan。计划模式下收尾时没调过就要出声,见 turn-end。
  let planSubmitted = false;
  // 本轮**开始时**是否就在计划模式。轮中途 shift+tab 切进计划模式的那一轮
  // 不该被追问方案——用户压根没让它规划,警告只会莫名其妙。
  let planAtTurnStart = false;

  const push = (item: NewTimelineItem) => {
    setItems((prev) => [...prev, { ...item, key: nextKey() } as TimelineItem]);
  };

  // 阶段切换保留 since(已用时连续);空闲时进入新阶段则从现在起计时。
  const beginWork = (phase: WorkPhase, detail?: string) => {
    setWork((prev) => ({ phase, detail, since: prev?.since ?? Date.now() }));
  };
  const endWork = () => setWork(undefined);

  // 把 agent 的事件总线接入信号。挂载期订阅一次,卸载即退订。
  {
    const flushText = () => {
      const text = activeText();
      setActiveText('');
      if (text.trim())
        push({ kind: 'assistant', text: text.trimEnd(), continuation: textCommitted() });
      setTextCommitted(false);
    };
    // 定稿的只是一行"已思考 8.2s":正文在流式期间实时可见,整段进时间线
    // 只会淹没回复和工具记录(见 types.ts 的 reasoning 条目)。
    const flushReasoning = () => {
      const text = activeReasoning();
      const startedAt = reasoningStartedAt;
      reasoningStartedAt = undefined;
      setActiveReasoning('');
      if (text.trim())
        push({
          kind: 'reasoning',
          durationMs: startedAt ? Date.now() - startedAt : undefined,
          text,
        });
    };
    // 中断(Esc)和流级异常不会给进行中的文本块补发 text-end/reasoning-end
    // (SDK 直接关闭流),已生成的部分回答必须在这里定稿,否则它永远进不了
    // 时间线,还会残留在累积区、被拼进下一轮的回答。进行中的工具行同样
    // 等不到 tool-end,一并清掉——结果若之后仍到达,tool-end 照常落时间线。
    const flushInterrupted = () => {
      flushReasoning();
      flushText();
      setActiveTools([]);
      setTaskProgress({});
    };

    const off = session.bus.on((event: AgentEvent) =>
      // batch:一条事件往往连着改好几个信号,合并成一次渲染刷新。
      batch(() => {
        switch (event.type) {
          case 'turn-start':
            push({ kind: 'user', text: event.display ?? event.userText });
            planSubmitted = false;
            planAtTurnStart = session.config.plan;
            turnStartedAt = Date.now();
            setTurnStartTokens(usage().total);
            // 新一轮从零开始计时,不沿用上一轮残留的 since。
            setWork({ phase: 'thinking', since: Date.now() });
            break;

          case 'text-delta': {
            const combined = activeText() + event.text;
            // 段落级增量提交:已被空行收尾的段落立即定稿为不可变条目(<For>
            // 按引用复用、markdown 走 LRU 缓存),正在生成的尾段作为活动条目
            // 在时间线尾部原地生长(opencode 式)——可变区始终只有一小段,
            // 每个 delta 的重渲染成本不随消息变长而膨胀。
            const { committed, rest } = splitCommitted(combined);
            if (committed) {
              push({ kind: 'assistant', text: committed, continuation: textCommitted() });
              setTextCommitted(true);
              setActiveText(rest);
            } else {
              setActiveText(combined);
            }
            beginWork('responding');
            break;
          }
          case 'text-end':
            flushText();
            break;

          case 'reasoning-delta':
            // 计时从第一个增量起,而不是订阅 reasoning-start:后者未必所有
            // provider 都发,且首个增量到达前屏幕上本来也没有思考在显示。
            reasoningStartedAt ??= Date.now();
            setActiveReasoning((prev) => prev + event.text);
            beginWork('thinking');
            break;
          case 'reasoning-end':
            flushReasoning();
            break;

          case 'tool-start':
            if (event.toolName === 'exit_plan') planSubmitted = true;
            toolInputs.set(event.callId, event.input);
            setActiveTools((prev) => [
              ...prev,
              {
                callId: event.callId,
                toolName: event.toolName,
                input: event.input,
                startedAt: Date.now(),
              },
            ]);
            beginWork('tool', event.toolName);
            break;

          case 'tool-end': {
            setActiveTools((prev) => prev.filter((call) => call.callId !== event.callId));
            setTaskProgress((prev) => {
              if (!(event.callId in prev)) return prev;
              const { [event.callId]: _gone, ...rest } = prev;
              return rest;
            });
            const input = toolInputs.get(event.callId);
            toolInputs.delete(event.callId);
            push({
              kind: 'tool',
              toolName: event.toolName,
              input,
              summary: event.summary,
              output: event.output,
              isError: event.isError,
              durationMs: event.durationMs,
            });
            beginWork('thinking');
            break;
          }

          case 'task-progress':
            setTaskProgress((prev) => ({
              ...prev,
              [event.callId]: {
                steps: event.steps,
                tokens: event.tokens,
                currentTool: event.currentTool,
                recentCalls: event.recentCalls,
              },
            }));
            break;

          case 'permission-request':
            opts.onPermissionRequest(event.request);
            beginWork('waiting');
            break;

          // 权限也可能由 exit_plan 在工具侧切换(方案获批),不订阅的话顶栏/
          // 底栏会一直停在 plan。命令侧的手动同步是同值 setState,留着不碍事。
          case 'permission-change':
            opts.onPermissionChange(event.permissions, event.plan);
            break;

          case 'step-end':
            setUsage({
              used: event.usage.inputTokens,
              window: event.usage.contextWindow,
              total: event.usage.cumulativeTotalTokens,
            });
            break;

          case 'turn-end':
            setUsage((prev) => ({ ...prev, total: event.usage.cumulativeTotalTokens }));
            // 计划模式下这一轮没提交过方案:提示词要求模型必须走 exit_plan,但那
            // 只是提示词——模型仍可能调研完直接作答就收尾。门禁保证了这一轮什么
            // 都没改动,但"我明明用了 /plan,它却没问我"必须看得见,不能静悄悄。
            if (planAtTurnStart && session.config.plan && !planSubmitted) {
              push({ kind: 'notice', level: 'warn', message: t('notice.planNoSubmission') });
            }
            // 一轮的收尾行。底栏给的是"此刻"的累计值,回看历史时无从知道
            // 某一轮花了多久、烧了多少——这一行补的正是这个。中断与出错各自
            // 走 aborted/error 分支(那里没有可信的用量),不画这一行。
            //
            // 没见过本轮的 turn-start 就不画:`--attach` 连上跑到一半的
            // server、或重连时重放缓冲已滚过 turn-start(server 回 gap),
            // 都会只收到 turn-end。那时基准是 0,耗时会写成 0ms,更糟的是
            // 整个会话的累计量会被当成这一轮的开销报出来。
            if (turnStartedAt) {
              push({
                kind: 'turn',
                model: opts.getModel(),
                durationMs: Date.now() - turnStartedAt,
                tokens: Math.max(0, event.usage.cumulativeTotalTokens - turnStartTokens()),
                // 命中率只在有可比的分母时才有意义:inputTokens 是本轮各步
                // 输入的累加(每步都重发全量上下文),分母恒正。
                inputTokens: event.usage.inputTokens,
                cachedTokens: event.usage.cachedInputTokens,
              });
              // 基准一次性消费:下一轮的 turn-start 会重新落桩,漏收的那轮
              // 不该借用上一轮的起点。
              turnStartedAt = 0;
            }
            // 目标循环**还会接着跑**时才留着状态行,交给紧随其后的 goal-evaluating
            // 接手;在这里熄灯的话,自动循环会每两轮闪一次"已空闲",像卡住了。
            //
            // 必须同时看 active:轮子还在流的时候 `/goal clear`(或 shift+tab 切进
            // 计划模式)已经把目标解除了,此刻 goal-stop 因为 isRunning 为真没敢
            // 熄灯,而这里 busy 仍是真(循环正停在 `await agent.run` 上),两处
            // 都放过去就再没人熄灯,状态行会一直转到用户开下一轮为止。
            if (!(session.goal.busy && session.goal.active)) endWork();
            break;

          case 'goal-start':
            opts.onGoalActiveChange(true);
            push({
              kind: 'notice',
              level: 'info',
              message: event.restored
                ? t('notice.goalRestored', { condition: event.condition })
                : t('notice.goalSet', {
                    condition: event.condition,
                    max: session.config.goalMaxTurns,
                  }),
            });
            break;

          case 'goal-evaluating':
            beginWork('evaluating');
            break;

          case 'goal-verdict':
            // 达成时的收尾文案由 goal-stop 给,这里不重复推第二条。
            if (!event.met) {
              push({
                kind: 'notice',
                level: 'info',
                message: t('notice.goalNotMet', {
                  reason: event.reason,
                  turn: event.turn,
                  max: event.maxTurns,
                }),
              });
            }
            break;

          case 'goal-stop':
            // replaced 后面紧跟着新目标的 goal-start,顺序保证了不会误熄。
            opts.onGoalActiveChange(false);
            push({
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
            });
            // `/goal clear` 可能是在一轮进行中发出的:那一轮还在流,别把状态行掐了。
            if (!session.agent.isRunning) endWork();
            break;

          // 压缩摘要流式生成中:状态行切到「压缩中」并推进进度条。手动
          // /compact 时命令侧已乐观置位,这里让条动起来;自动压缩(开轮/
          // 轮中)则靠这一条把「思考中」换成真实状态。摘要总长事先未知,
          // 按典型长度估算、封顶 99%——估短了只会让条提前贴住 99%,绝不
          // 回退;真正的收尾由 compaction 事件兑现,所以条永远不自走满格。
          case 'compaction-progress':
            setWork((prev) => ({
              phase: 'compacting',
              progress: Math.min(0.99, event.chars / COMPACT_EXPECTED_SUMMARY_CHARS),
              since: prev?.since ?? Date.now(),
            }));
            break;

          case 'compaction':
            push({
              kind: 'notice',
              level: 'info',
              message: t('notice.compacted', {
                removed: event.removedMessages,
                chars: event.summaryChars,
              }),
            });
            // 压缩收尾:自动压缩发生在一轮进行中,把状态还给「思考中」;
            // 手动 /compact(空闲)直接熄灯——命令处理器 await 后的 endWork
            // 是兜底。压缩失败没有这条事件,状态由错误 notice 之后的流事件
            // (reasoning/text/tool 的 beginWork)自愈。
            setWork((prev) =>
              prev?.phase === 'compacting'
                ? session.agent.isRunning
                  ? { phase: 'thinking', since: prev.since }
                  : undefined
                : prev,
            );
            break;

          case 'notice':
            push({ kind: 'notice', level: event.level, message: event.message });
            break;

          case 'error':
            flushInterrupted();
            push({ kind: 'error', message: event.error.message });
            endWork();
            break;

          case 'aborted':
            flushInterrupted();
            push({ kind: 'notice', level: 'warn', message: t('notice.interrupted') });
            endWork();
            break;

          default:
            break;
        }
      }),
    );
    onCleanup(off);
  }

  // 启动时就带着目标(`mojocode -c` 恢复的会话):bootstrap 在 App 挂载之前
  // 就 restore 过了,那条 goal-start 没人听见。这里补一次提示。只在挂载时跑
  // 一次,所以 TUI 内 /resume 恢复的目标仍由实时事件呈现,不会重复两条。
  {
    const restored = session.goal.state;
    if (restored?.restored) {
      push({
        kind: 'notice',
        level: 'info',
        message: t('notice.goalRestored', { condition: restored.condition }),
      });
    }
  }

  return {
    items,
    activeText,
    activeReasoning,
    activeTools,
    taskProgress,
    work,
    usage,
    textCommitted,
    turnTokens,
    push,
    setItems,
    setWork,
    endWork,
    setUsage,
  };
}
