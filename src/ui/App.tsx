import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { Box, ScrollArea, Text, useApp, useInput, useSelectionCopy, useTerminalSize, type JSX } from './kit.js';
import { Footer } from './Footer.js';
import { Input, formatCommandLabel, type CommandOption, type SlashCommand } from './Input.js';
import { StatusLine, type WorkPhase, type WorkState } from './StatusLine.js';
import { TodoPanel } from './TodoPanel.js';
import { GoalLine } from './GoalLine.js';
import { TimelineEntry } from './Timeline.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import {
  theme,
  glyphs,
  formatDuration,
  formatToolInput,
  formatTokens,
  toolDisplayName,
  truncateWidth,
  WIDTH_SAFETY,
} from './theme.js';
import { Markdown } from './Markdown.js';
import { collapseItems } from './focus.js';
import { splitCommitted, tailWithinRows } from './preview.js';
import type { ActiveToolCall, NewTimelineItem, TimelineItem } from './types.js';
import type {
  AgentEvent,
  GoalStopReason,
  PermissionDecision,
  PermissionRequest,
} from '../core/events.js';
import { ProviderSwitchError } from '../app/bootstrap.js';
import type { SessionHandle } from '../app/session-handle.js';
import { SessionStore } from '../session/store.js';
import { collectRewindEntries, replayTimeline, type RewindEntry } from '../session/replay.js';
import { RewindPicker } from './RewindPicker.js';
import type { TodoItem } from '../tools/index.js';
import {
  APPROVAL_PRESETS,
  STATUS_SEGMENTS,
  canEverWrite,
  isEphemeralPermissions,
  nextCycleStep,
  permissionsLabel,
  presetById,
  reasoningEffortSchema,
  TIMELINE_MODES,
  type ApprovalPresetId,
  type Permissions,
  type ReasoningEffort,
  type StatusSegment,
  type TimelineMode,
} from '../config/schema.js';
import { BUILTIN_PROVIDER_IDS, PROVIDER_PRESETS } from '../config/providers.js';
import {
  saveLanguage,
  savePermissions,
  saveModelChoice,
  saveProviderChoice,
  saveReasoningEffort,
  saveStatusBar,
  saveTimelineMode,
} from '../config/save.js';
import { supportedEfforts } from '../model/reasoning.js';
import { LOCALES, getLocale, isLocale, setLocale, t, type Locale, type MessageKey } from '../i18n/index.js';
import { INIT_PROMPT } from '../agent/init.js';
import { createFileLister } from '../app/file-index.js';
import { expandAtReferences, warnableSkips, type ImageAttachment } from '../app/attachments.js';
import { readClipboardImage } from '../app/clipboard.js';
import { formatDoctor } from '../app/doctor.js';

/** 每次渲染时重建,使 /lang 与配置中的语言设置都能生效。 */
function buildCommands(): SlashCommand[] {
  return [
    { name: 'help', description: t('cmd.help') },
    { name: 'init', description: t('cmd.init') },
    { name: 'plan', description: t('cmd.plan') },
    { name: 'goal', description: t('cmd.goal') },
    { name: 'model', description: t('cmd.model') },
    { name: 'provider', description: t('cmd.provider') },
    { name: 'approvals', description: t('cmd.approvals') },
    { name: 'think', description: t('cmd.think') },
    { name: 'lang', description: t('cmd.lang') },
    { name: 'statusbar', description: t('cmd.statusbar'), multi: true },
    { name: 'focus', description: t('cmd.focus') },
    { name: 'compact', description: t('cmd.compact') },
    { name: 'new', description: t('cmd.new') },
    { name: 'clear', description: t('cmd.clear') },
    { name: 'mcp', description: t('cmd.mcp') },
    { name: 'doctor', description: t('cmd.doctor') },
    { name: 'cost', description: t('cmd.cost') },
    { name: 'resume', description: t('cmd.resume') },
    { name: 'fork', description: t('cmd.fork') },
    { name: 'exit', aliases: ['quit'], description: t('cmd.exit') },
  ];
}

/** `/approvals` 二级选择器里各预设的说明。 */
const PRESET_DESCRIPTIONS: Record<ApprovalPresetId, MessageKey> = {
  'read-only': 'approvalopt.readOnly',
  ask: 'approvalopt.ask',
  auto: 'approvalopt.auto',
  'full-access': 'approvalopt.fullAccess',
};

/** 思考档位的选择器说明。/think 不进 BUSY_BLOCKED_COMMANDS:改档位对进行中
 * 的流无破坏,下一次请求才生效。 */
const THINK_DESCRIPTIONS: Record<ReasoningEffort, MessageKey> = {
  auto: 'thinkopt.auto',
  off: 'thinkopt.off',
  low: 'thinkopt.low',
  medium: 'thinkopt.medium',
  high: 'thinkopt.high',
  max: 'thinkopt.max',
};

/** 运行中会和进行中的流互相踩踏的命令(改历史、换模型)。 */
const BUSY_BLOCKED_COMMANDS = new Set(['new', 'clear', 'compact', 'model', 'provider', 'resume', 'fork', 'init']);

/**
 * `/goal` 的取消词。它们是**参数**而不是命令别名(命令别名会进补全菜单,
 * 而 `/stop`、`/off` 单独成命令毫无意义),与 Claude Code 对齐。
 */
const GOAL_CLEAR_WORDS = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel']);

/** goal-stop 的原因 → 文案。穷尽 Record:新增停止原因时编译期就会提醒补文案。 */
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

/** `/focus` 二级选择器里各档位的说明。 */
const FOCUS_DESCRIPTIONS: Record<TimelineMode, MessageKey> = {
  full: 'focusopt.full',
  compact: 'focusopt.compact',
  result: 'focusopt.result',
};

const SEGMENT_DESCRIPTIONS: Record<StatusSegment, MessageKey> = {
  mode: 'statusopt.mode',
  model: 'statusopt.model',
  cwd: 'statusopt.cwd',
  think: 'statusopt.think',
  context: 'statusopt.context',
  total: 'statusopt.total',
  todos: 'statusopt.todos',
};

/** 语言名用各自的母语写法展示,不做翻译。 */
const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
};

/**
 * 流式预览占用的终端行数上限。全屏布局下这不再是防漏帧的硬约束,只是
 * 视觉取舍:预览太高会把时间线挤得只剩一条缝。完整文本在 text-end 时
 * 进入时间线,预览截断不丢内容。
 *
 * 思考不同:定稿只留一行"已思考 8.2s",正文**只在这个预览里出现过一次**,
 * 之后再无回看途径,所以行数给得比正文预览的道理更足——它是唯一的窗口。
 */
const STREAM_PREVIEW_ROWS = 5;
const REASONING_PREVIEW_ROWS = 5;


let itemCounter = 0;
const nextKey = () => `item-${itemCounter++}`;

/**
 * 启动横幅条目:字段取自 session 的当前值。会话中途 /model、shift+tab
 * 改掉的值走 App 内的 bannerItem(那边读的是 state 镜像)。
 */
function sessionBanner(session: SessionHandle): TimelineItem {
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
 */
function buildResumeItems(session: SessionHandle): TimelineItem[] {
  const messages = session.store.messages;
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

interface Props {
  session: SessionHandle;
  /**
   * 退出 dump 用:App 把当前时间线同步进来,cli.tsx 在 TUI 退出、主屏恢复后
   * 据此把整场会话以纯文本写回终端 scrollback(alternate screen 里画过的
   * 东西随退出消失,这是唯一的留痕通道)。
   */
  itemsRef?: { current: TimelineItem[] };
}

export function App(props: Props): JSX.Element {
  const session = props.session;
  const { exit } = useApp();
  const size = useTerminalSize();

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
  const [taskProgress, setTaskProgress] = createSignal<
    Record<
      string,
      {
        steps: number;
        tokens: number;
        currentTool?: string;
        recentCalls?: Array<{ toolName: string; input: unknown }>;
      }
    >
  >({});
  const [permission, setPermission] = createSignal<PermissionRequest | undefined>(undefined);
  const [running, setRunning] = createSignal(false);
  // 工作状态:undefined 表示空闲(状态行隐藏)。since 在整轮工作中保持
  // 不变,阶段切换只更新文字和颜色,已用时连续累计。
  const [work, setWork] = createSignal<WorkState | undefined>(undefined);
  // 从 store 取初值:恢复会话时 restoreState 在 bootstrap 阶段就填好了
  // todos,那时还没有订阅者,只靠 subscribe 的话要等模型下次调 todo 工具
  // 才显示。
  const [todos, setTodos] = createSignal<TodoItem[]>(session.todos.get());
  // ctrl+t 折叠/展开工作中的实时任务面板;偏好保持整个会话。
  //
  // 默认关闭(与 Claude Code 一致):模型每次调 todo 工具,时间线上就多一条
  // 完整清单,而面板画的正是同一份当前状态——两者逐字相同、上下紧挨着,
  // 常驻会让屏幕上重复好几份同样的任务。平时看时间线的记录即可,需要盯
  // 实时进度时再按 ctrl+t 调出来(状态行一直提示这个快捷键)。
  const [todoPanelOpen, setTodoPanelOpen] = createSignal(false);
  const [usage, setUsage] = createSignal({ used: 0, window: session.provider.contextWindow, total: 0 });
  const [providerLabel, setProviderLabel] = createSignal(session.provider.label);
  const [model, setModel] = createSignal(session.provider.model);
  // 两轴权限 + plan 标志。UI 展示与判断都从这份镜像取,靠 permission-change
  // 事件与 bootstrap 同步。
  const [perms, setPerms] = createSignal<Permissions>({
    sandbox: session.config.sandbox,
    approval: session.config.approval,
  });
  const [planActive, setPlanActive] = createSignal(session.config.plan);
  // 有没有目标在身。只管"那一行要不要渲染";轮数与已用时由 GoalLine 自己
  // 按秒现取——目标循环两轮之间几十秒里 App 没有任何信号变化,靠 props
  // 传快照会一直停在设定目标那一刻的数字。初值取 session:`mojocode -c`
  // 恢复的目标在首帧就该显示出来。
  const [goalActive, setGoalActive] = createSignal(session.goal.active);
  // 状态栏/头部显示的标签:plan 压过两轴。
  const modeLabel = () => (planActive() ? 'plan' : permissionsLabel(perms()));
  const [think, setThink] = createSignal<ReasoningEffort>(session.provider.reasoningEffort);
  const [ctrlCArmed, setCtrlCArmed] = createSignal(false);
  const [locale, setLocaleState] = createSignal(getLocale());
  const [statusSegments, setStatusSegments] = createSignal<StatusSegment[]>(session.config.statusBar);
  // esc-esc 回退:第一次 esc 预备(footer 提示),第二次打开回退选择器。
  const [escArmed, setEscArmed] = createSignal(false);
  // shift+tab 切换后在状态栏短暂回显新档位:mode 段可能被 /statusbar 关掉,
  // Header 又只在默认档时不显示且早已滚出屏幕——没有这个回显,按下去会毫无反馈。
  const [modeFlash, setModeFlash] = createSignal<string | undefined>(undefined);
  let modeFlashTimer: NodeJS.Timeout | undefined;
  // /focus 时间线密度;ctrl+o 会话内循环切换,/focus <mode> 落盘。
  // `?? 'full'` 防御测试里的精简版 fake session(config 缺字段)。
  const [timelineMode, setTimelineMode] = createSignal<TimelineMode>(
    session.config.timeline ?? 'full',
  );
  // ctrl+o 切换后在 footer 短暂回显新档位(与 modeFlash 同理:得有反馈)。
  const [focusFlash, setFocusFlash] = createSignal<TimelineMode | undefined>(undefined);
  let focusFlashTimer: NodeJS.Timeout | undefined;
  // 拖选自动复制后的回显(字符数)。
  const [copyFlash, setCopyFlash] = createSignal<number | undefined>(undefined);
  let copyFlashTimer: NodeJS.Timeout | undefined;
  const [rewind, setRewind] = createSignal<RewindEntry[] | undefined>(undefined);
  // 回退后预填输入框的内容;Input 写入后回调清空,避免它重挂载时二次覆盖
  // 用户的新草稿。
  const [prefill, setPrefill] = createSignal<{ text: string } | undefined>(undefined);
  const clearPrefill = () => setPrefill(undefined);

  // 待处理的权限 resolver。Solid 下就是普通变量:处理器读的永远是当前值。
  let resolvePermission: ((decision: PermissionDecision) => void) | undefined;

  // 本段思考的起始时刻,定稿那一行的耗时由它算出。undefined 表示当前没有
  // 进行中的思考块。
  let reasoningStartedAt: number | undefined;

  // 当前流式文本块是否已有段落提前定稿(增量提交):后续片段渲染时
  // 不再带 ● 前缀,只缩进对齐。
  let textCommitted = false;

  // `tool-end` 不携带调用的输入,所以在 `tool-start` 时先记下来。
  const toolInputs = new Map<string, unknown>();

  // 本轮是否调用过 exit_plan。计划模式下收尾时没调过就要出声,见 turn-end。
  let planSubmitted = false;
  // 本轮**开始时**是否就在计划模式。轮中途 shift+tab 切进计划模式的那一轮
  // 不该被追问方案——用户压根没让它规划,警告只会莫名其妙。
  let planAtTurnStart = false;

  let ctrlCTimer: NodeJS.Timeout | undefined;
  let escTimer: NodeJS.Timeout | undefined;
  /**
   * 已受理但尚未发起 run() 的提交(@ 引用展开是异步的)。这段窗口里
   * agent 仍是 idle,esc 与 busy 拦截都要把它当作"忙"看待;submitGen
   * 递增即作废在途提交。
   */
  let submitPending = false;
  let submitGen = 0;

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
        push({ kind: 'assistant', text: text.trimEnd(), continuation: textCommitted });
      textCommitted = false;
    };
    // 定稿的只是一行"已思考 8.2s":正文在流式期间实时可见,整段进时间线
    // 只会淹没回复和工具记录(见 types.ts 的 reasoning 条目)。
    const flushReasoning = () => {
      const text = activeReasoning();
      const startedAt = reasoningStartedAt;
      reasoningStartedAt = undefined;
      setActiveReasoning('');
      if (text.trim())
        push({ kind: 'reasoning', durationMs: startedAt ? Date.now() - startedAt : undefined });
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
            // 新一轮从零开始计时,不沿用上一轮残留的 since。
            setWork({ phase: 'thinking', since: Date.now() });
            break;

          case 'text-delta': {
            const combined = activeText() + event.text;
            // 段落级增量提交:已被空行收尾的段落立即定稿进时间线,预览只留
            // 正在生成的尾段。动态区高度天然受控,已生成内容随时可回看。
            const { committed, rest } = splitCommitted(combined);
            if (committed) {
              push({ kind: 'assistant', text: committed, continuation: textCommitted });
              textCommitted = true;
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
            setPermission(event.request);
            beginWork('waiting');
            break;

          // 权限也可能由 exit_plan 在工具侧切换(方案获批),不订阅的话顶栏/
          // 底栏会一直停在 plan。命令侧的手动同步是同值 setState,留着不碍事。
          case 'permission-change':
            setPerms(event.permissions);
            setPlanActive(event.plan);
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
            setGoalActive(true);
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
            setGoalActive(false);
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

          case 'compaction':
            push({
              kind: 'notice',
              level: 'info',
              message: t('notice.compacted', {
                removed: event.removedMessages,
                chars: event.summaryChars,
              }),
            });
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

  {
    const off = session.todos.subscribe(setTodos);
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

  // 把权限门禁的询问回调桥接到确认提示组件。
  session.gate.setAsker((request) => {
    setPermission(request);
    return new Promise<PermissionDecision>((resolve) => {
      resolvePermission = resolve;
    });
  });

  const onDecide = (decision: PermissionDecision) => {
    setPermission(undefined);
    // 决定之后 agent 继续跑,状态从"等待确认"回到"思考中";若拒绝导致
    // 回合结束,turn-end/aborted 会随后把状态清掉。
    setWork((prev) => (prev ? { phase: 'thinking', since: prev.since } : prev));
    const resolve = resolvePermission;
    resolvePermission = undefined;
    resolve?.(decision);
  };

  // ctrl+c 无论何时都要能退出(包括权限确认框打开时),所以单独一个
  // 始终激活的处理器。依赖 kit render() 默认的 exitOnCtrlC: false——否则
  // 渲染器会在 useInput 之前吞掉这个按键,这里永远收不到。
  useInput((input, key) => {
    // shift+tab 循环切权限档位(ask → auto → plan),与 Claude Code /
    // Codex 的手感一致。full-access 刻意不在循环里。授权确认框开着时不接:
    // 那会在你决定"要不要放行这一次"的中途改掉规则本身。
    // 回退选择器打开时同样不接:它渲染期间 Footer 已卸载,切了档位没有任何
    // 反馈,之后的写操作会在用户不知情的模式下放行。
    if (key.tab && key.shift && !permission() && !rewind()) {
      const step = nextCycleStep(
        { sandbox: session.config.sandbox, approval: session.config.approval },
        session.config.plan,
      );
      let label: string;
      if ('plan' in step) {
        session.setPlan(true);
        setPlanActive(true);
        label = 'plan';
      } else {
        const next = presetById(step.preset);
        session.setPermissions(next);
        setPerms(next);
        setPlanActive(false);
        label = step.preset;
      }
      // 只在本会话生效,不落盘:一个随手的按键不该改写工作区配置。
      setModeFlash(label);
      if (modeFlashTimer) clearTimeout(modeFlashTimer);
      modeFlashTimer = setTimeout(() => setModeFlash(undefined), 2000);
      return;
    }
    if (key.ctrl && input === 't') {
      setTodoPanelOpen((open) => !open);
      return;
    }
    // ctrl+o 循环时间线密度(/focus)。全屏渲染下切换 = 重画,随时可逆。
    if (key.ctrl && input === 'o') {
      const next =
        TIMELINE_MODES[(TIMELINE_MODES.indexOf(timelineMode()) + 1) % TIMELINE_MODES.length]!;
      setTimelineMode(next);
      session.config.timeline = next;
      setFocusFlash(next);
      if (focusFlashTimer) clearTimeout(focusFlashTimer);
      focusFlashTimer = setTimeout(() => setFocusFlash(undefined), 2000);
      return;
    }
    if (key.ctrl && input === 'c') {
      if (ctrlCArmed()) {
        // 必须清掉待触发的定时器:cli.tsx 只设置 process.exitCode 而不调用
        // process.exit(),挂着的定时器会让事件循环多活 2 秒才退出。
        if (ctrlCTimer) clearTimeout(ctrlCTimer);
        exit();
      } else {
        setCtrlCArmed(true);
        ctrlCTimer = setTimeout(() => setCtrlCArmed(false), 2000);
      }
    }
  });

  // 全部定时器都要清:cli.tsx 只设 process.exitCode 而不调 process.exit(),
  // 任何挂着的定时器都会让事件循环多活到它触发为止——按过 shift+tab 之后
  // 两秒内连按 ctrl+c 退出,进程会僵在那里等这个回显定时器。
  onCleanup(() => {
    if (ctrlCTimer) clearTimeout(ctrlCTimer);
    if (escTimer) clearTimeout(escTimer);
    if (modeFlashTimer) clearTimeout(modeFlashTimer);
    if (focusFlashTimer) clearTimeout(focusFlashTimer);
    if (copyFlashTimer) clearTimeout(copyFlashTimer);
  });

  // 拖选松手自动复制到剪贴板(kit.useSelectionCopy),footer 回显字符数。
  useSelectionCopy((chars) => {
    setCopyFlash(chars);
    if (copyFlashTimer) clearTimeout(copyFlashTimer);
    copyFlashTimer = setTimeout(() => setCopyFlash(undefined), 2000);
  });

  // 重建时间线时的横幅:与 sessionBanner 的区别是读 state 镜像,/model、
  // shift+tab 等会话中途的改动会反映进去。
  const bannerItem = (): TimelineItem => ({
    key: nextKey(),
    kind: 'banner',
    providerLabel: providerLabel(),
    model: model(),
    root: session.root,
    mode: modeLabel(),
    mcpSummary:
      session.mcpStatuses.length > 0
        ? `${session.mcpStatuses.filter((s) => s.connected).length}/${session.mcpStatuses.length}`
        : undefined,
  });

  // 重放时间线:/resume 与 esc-esc 回退共用。全屏渲染下这只是一次普通的
  // 信号赋值——渲染器每帧整屏重画,没有累积输出要清。
  const resetTimeline = (nextItems: TimelineItem[]) => {
    setItems(nextItems);
  };

  /** esc 的总入口:运行中 → 中断;空闲二连 esc → 回退选择器。 */
  const handleEscape = () => {
    // 提交已受理但 @ 引用还在展开(run 尚未发起):作废这一次提交。
    // 注意不能就此返回——运行中提交的是引导消息,此时按 esc 要的是中断
    // 那一轮,只取消引导会表现为"esc 没反应,状态栏却灭了"。
    if (submitPending) {
      submitGen++;
      submitPending = false;
      if (!session.agent.isRunning && !session.goal.busy) {
        setRunning(false);
        return;
      }
    }
    if (session.agent.isRunning) {
      // 目标循环进行中时,中断这一轮就够了:那一轮收不到 turn-end,
      // GoalController 据此停下整个循环(见它的 run())。
      session.agent.abort();
      return;
    }
    // 评估窗口:agent 是空闲的,但用户按 esc 要停的是整个循环。不拦下的话
    // 这次 esc 会去武装回退选择器,而循环转头又若无其事地开了下一轮。
    if (session.goal.busy) {
      session.goal.clear('aborted');
      return;
    }
    // 压缩期间历史随时会被替换,回退下标不可靠,不开选择器。
    if (session.agent.isCompacting) return;
    if (!escArmed()) {
      setEscArmed(true);
      if (escTimer) clearTimeout(escTimer);
      escTimer = setTimeout(() => setEscArmed(false), 2000);
      return;
    }
    if (escTimer) clearTimeout(escTimer);
    setEscArmed(false);
    const entries = collectRewindEntries(session.agent.history);
    if (entries.length === 0) {
      push({ kind: 'notice', level: 'warn', message: t('notice.rewindNothing') });
      return;
    }
    setRewind(entries);
  };

  const handleRewindPick = (entry: RewindEntry) => {
    setRewind(undefined);
    // 截断到目标消息之前;setHistory 会递增 historyGeneration,顺带作废
    // 任何在途压缩的结果。store.save 的引用前缀比较失败 → 自动落 snapshot。
    session.agent.setHistory(session.agent.history.slice(0, entry.index));
    void session.store.save(session.agent.history).catch((err: Error) => {
      push({ kind: 'notice', level: 'warn', message: t('notice.sessionSaveFailed', { message: err.message }) });
    });
    const replayed = replayTimeline(session.agent.history).map(
      (item) => ({ ...item, key: nextKey() }) as TimelineItem,
    );
    resetTimeline([bannerItem(), ...replayed]);
    // 上下文用量归零:历史刚变短,旧数字会一直挂到下一轮 step-end。
    // 累计消耗保留——那些 token 确实花掉了。
    setUsage((prev) => ({ ...prev, used: 0 }));
    push({ kind: 'notice', level: 'info', message: t('notice.rewound', { n: entry.ordinal }) });
    // 原消息放回输入框,编辑后重发即分叉出新的走向。
    setPrefill({ text: entry.text });
  };


  const runCommand = async (raw: string) => {
    const [name, ...rest] = raw.slice(1).trim().split(/\s+/);
    const arg = rest.join(' ');

    // 这些命令会改写正在被进行中的流读写的历史/模型,运行中禁止。
    // 压缩没有 controller,isRunning 期间为 false——不把它算进来的话,
    // /compact 等待摘要返回时还能执行 /clear,压缩随后会把已丢弃的对话
    // 写回内存,并存进那个全新的会话文件。
    // goal.busy 必须并进来:目标循环两轮之间的评估窗口里 agent 是空闲的,
    // 但历史随时会被下一轮接着写——不算作忙的话,`/clear`、`/model`、
    // `/resume` 会从这个缝里溜进去把历史或模型换掉。
    const busy =
      session.agent.isRunning ||
      session.agent.isCompacting ||
      submitPending ||
      session.goal.busy;
    if (name && BUSY_BLOCKED_COMMANDS.has(name) && busy) {
      push({ kind: 'notice', level: 'warn', message: t('notice.busyCommand', { name }) });
      return;
    }

    switch (name) {
      case 'help':
        push({
          kind: 'notice',
          level: 'info',
          message: buildCommands()
            .map((c) => `${formatCommandLabel(c)} — ${c.description}`)
            .join('\n'),
        });
        break;

      case 'exit':
      case 'quit':
        exit();
        break;

      // 与 Claude Code 一致:两者都丢弃当前对话、换新的会话文件;
      // /clear 额外清掉终端屏幕与回滚缓冲,/new 保留已滚出的历史。
      case 'new':
      case 'clear': {
        try {
          await session.newSession();
        } catch (err) {
          push({
            kind: 'notice',
            level: 'warn',
            message: t('notice.newSessionFailed', { message: (err as Error).message }),
          });
          break;
        }
        // 清空时间线,只留横幅,回到和启动时一致的界面。全屏渲染下
        // /clear 与 /new 的屏幕表现相同(没有终端回滚缓冲可清),差异
        // 只剩语义上的会话文件切换,都由上面的 newSession 完成。
        setItems([bannerItem()]);
        setUsage((prev) => ({ ...prev, used: 0, total: 0 }));
        break;
      }

      // `/init` 是唯一发起完整 agent 轮的命令:时间线上只回显 `/init`
      // (turn-start 的 display),完整指令进历史喂模型。轮结束后刷新
      // 环境信息,让刚生成的 AGENTS.md 立刻进入系统提示词。
      case 'init': {
        // 写入完全不可能的组合(plan、read-only+never)下这一轮注定写不出
        // AGENTS.md,提前拦下,别白烧一轮 token。read-only+on-request 放行:
        // 写入可以逐次升级确认。
        if (!canEverWrite(perms(), planActive())) {
          push({
            kind: 'notice',
            level: 'warn',
            message: t('notice.initReadonly', { mode: modeLabel() }),
          });
          break;
        }
        setRunning(true);
        void session.agent
          .run(INIT_PROMPT, { display: '/init' })
          .then(() => session.refreshEnvironment())
          // run() 自己消化模型错误,但 refreshEnvironment 是新的一环:
          // 不接住的话 rejection 会掀掉整个 TUI(Node ≥20 视为致命)。
          .catch((err: Error) => {
            push({ kind: 'notice', level: 'warn', message: t('notice.initFailed', { message: err.message }) });
          })
          .finally(() => setRunning(false));
        break;
      }

      // 计划模式:裸 /plan 只切模式,`/plan <任务>` 顺带以任务原文发起一轮。
      // 任务原文直接进历史(不像 /init 那样套 display):用户写的就是他的
      // 意图本身,实时时间线与 /resume 回放因此天然一致,回退重发也能重跑。
      case 'plan': {
        // 带参数会发起一轮,运行中禁止。不走 BUSY_BLOCKED_COMMANDS——那张表
        // 按命令名判断,表达不了"只有带参数时才拦"。
        if (arg && busy) {
          push({ kind: 'notice', level: 'warn', message: t('notice.busyCommand', { name }) });
          break;
        }
        if (!planActive()) {
          // read-only+never 进来的话批准后会提升到 ask,提前说明,免得用户
          // 以为设置被吞了。其余组合忠实还原,不必多话。
          if (!canEverWrite(perms(), false)) {
            push({ kind: 'notice', level: 'info', message: t('notice.planReturnFromReadonly') });
          }
          session.setPlan(true);
          setPlanActive(true);
          push({ kind: 'notice', level: 'info', message: t('notice.planEntered') });
        }
        if (!arg) break;
        setRunning(true);
        void session.agent
          .run(arg)
          // run() 自己消化模型错误,但未捕获的 rejection 在 Node ≥20 会掀掉
          // 整个 TUI——与 /init 同一条教训。
          .catch((err: Error) => {
            push({ kind: 'notice', level: 'warn', message: err.message });
          })
          .finally(() => setRunning(false));
        break;
      }

      // 目标模式:给一个完成条件,每轮收尾后由评估器判断达成没有,没达成
      // 就以评估理由为指令自动续跑。裸 /goal 报状态、`/goal clear` 取消,
      // 这两支任何时候都可用——clear 正是停下循环的手段,拦忙就没法停了。
      case 'goal': {
        const status = session.goal.snapshot();
        if (!arg) {
          push({
            kind: 'notice',
            level: 'info',
            message: !status
              ? t('notice.goalNone')
              : status.restored
                ? t('notice.goalStatusIdle', { condition: status.condition })
                : t('notice.goalStatus', {
                    condition: status.condition,
                    turns: status.turns,
                    max: status.maxTurns,
                    elapsed: formatDuration(status.elapsedMs),
                    tokens: formatTokens(status.tokens),
                    reason: status.lastReason || '—',
                  }),
          });
          break;
        }
        if (GOAL_CLEAR_WORDS.has(arg.toLowerCase())) {
          // 提示统一由 goal-stop 事件给出,这里不再推一条。
          if (status) session.goal.clear('cleared');
          else push({ kind: 'notice', level: 'info', message: t('notice.goalNone') });
          break;
        }
        // 以下这支会发起一轮,所以要拦忙——和 `/plan <任务>` 同一个理由,
        // 同样不进 BUSY_BLOCKED_COMMANDS(那张表按命令名判断,表达不了
        // "只有这种参数形式才拦")。
        if (busy) {
          push({ kind: 'notice', level: 'warn', message: t('notice.busyCommand', { name }) });
          break;
        }
        if (planActive()) {
          push({ kind: 'notice', level: 'warn', message: t('notice.goalPlanMode') });
          break;
        }
        session.goal.set(arg);
        setRunning(true);
        void session.goal
          .run(arg)
          // goal.run 和 agent.run 一样不会 reject,但未捕获的 rejection 在
          // Node ≥20 会掀掉整个 TUI——与 /init、/plan 同一条教训,照旧兜住。
          .catch((err: Error) => {
            push({ kind: 'notice', level: 'warn', message: err.message });
          })
          .finally(() => setRunning(false));
        break;
      }

      case 'compact':
        setWork({ phase: 'compacting', since: Date.now() });
        setRunning(true);
        await session.agent.compact().catch((err: Error) => {
          push({ kind: 'error', message: t('notice.compactFailed', { message: err.message }) });
        });
        setRunning(false);
        endWork();
        break;

      case 'approvals': {
        const preset = APPROVAL_PRESETS.find((p) => p.id === arg);
        if (!preset) {
          push({
            kind: 'notice',
            level: 'warn',
            message: t('notice.approvalsUsage', {
              list: APPROVAL_PRESETS.map((p) => p.id).join('|'),
              mode: modeLabel(),
            }),
          });
          break;
        }
        const next = presetById(preset.id);
        session.setPermissions(next);
        setPerms(next);
        setPlanActive(false);
        push({ kind: 'notice', level: 'info', message: t('notice.modeSet', { mode: preset.id }) });
        // 落盘范围是本工作区的 .mojocode/config.json;full-access 不保存,
        // 提示它只管这一次。
        const saved = await savePermissions(session.root, next).catch((err: Error) => {
          push({ kind: 'notice', level: 'warn', message: t('notice.modeSaveFailed', { message: err.message }) });
          return undefined;
        });
        if (isEphemeralPermissions(next)) {
          push({
            kind: 'notice',
            level: 'warn',
            message: t('notice.modeSessionOnly', { mode: preset.id }),
          });
        } else if (saved) {
          push({ kind: 'notice', level: 'info', message: t('notice.modeSavedTo', { path: saved }) });
        }
        break;
      }

      case 'think': {
        // 档位与当前 provider/model 绑定:只接受它能完整表达的值,
        // 不支持的档位直接拒绝并列出可用项。
        const valid = supportedEfforts(session.provider);
        const parsed = reasoningEffortSchema.safeParse(arg);
        if (!parsed.success || !valid.includes(parsed.data)) {
          push({
            kind: 'notice',
            level: 'warn',
            message: t('notice.thinkUsage', { list: valid.join('|'), level: think() }),
          });
          break;
        }
        const level = parsed.data;
        // 档位必须落到真正跑模型的进程:本地会话改共享的 provider/config
        // 对象,远程会话(client-server)则经 RPC 送达——细节收进 Session 契约。
        // RPC 会 reject(server 抖动),而 runCommand 是 `void` 调用的:
        // 不接住就是未捕获 rejection,整个 TUI 被掀掉。
        try {
          await session.setReasoningEffort(level);
        } catch (err) {
          push({ kind: 'error', message: (err as Error).message });
          break;
        }
        setThink(level);
        push({ kind: 'notice', level: 'info', message: t('notice.thinkSet', { level }) });
        await saveReasoningEffort(session.provider.id, level).catch((err: Error) => {
          push({ kind: 'notice', level: 'warn', message: t('notice.thinkSaveFailed', { message: err.message }) });
        });
        break;
      }

      case 'lang': {
        if (!arg || !isLocale(arg)) {
          push({
            kind: 'notice',
            level: 'warn',
            message: t('notice.langUsage', { lang: getLocale() }),
          });
          break;
        }
        setLocale(arg);
        setLocaleState(arg);
        push({ kind: 'notice', level: 'info', message: t('notice.langSet', { lang: arg }) });
        await saveLanguage(arg).catch((err: Error) => {
          push({ kind: 'notice', level: 'warn', message: t('notice.langSaveFailed', { message: err.message }) });
        });
        break;
      }

      case 'focus': {
        if (!arg || !(TIMELINE_MODES as readonly string[]).includes(arg)) {
          push({
            kind: 'notice',
            level: arg ? 'warn' : 'info',
            message: t('notice.focusUsage', {
              list: TIMELINE_MODES.join(' | '),
              current: timelineMode(),
            }),
          });
          break;
        }
        const next = arg as TimelineMode;
        setTimelineMode(next);
        session.config.timeline = next;
        push({ kind: 'notice', level: 'info', message: t('notice.focusSet', { mode: next }) });
        await saveTimelineMode(next).catch((err: Error) => {
          push({
            kind: 'notice',
            level: 'warn',
            message: t('notice.focusSaveFailed', { message: err.message }),
          });
        });
        break;
      }

      case 'statusbar': {
        const currentList = statusSegments().join(' ') || 'none';
        if (!arg) {
          push({
            kind: 'notice',
            level: 'info',
            message: t('notice.statusbarUsage', { list: currentList }),
          });
          break;
        }
        const parts = arg === 'none' ? [] : arg.split(/\s+/);
        const invalid = parts.filter((p) => !(STATUS_SEGMENTS as readonly string[]).includes(p));
        if (invalid.length > 0) {
          push({
            kind: 'notice',
            level: 'warn',
            message: t('notice.statusbarUsage', { list: currentList }),
          });
          break;
        }
        // 按固定顺序规范化,同时去重。
        const next = STATUS_SEGMENTS.filter((s) => parts.includes(s));
        setStatusSegments(next);
        session.config.statusBar = next;
        push({
          kind: 'notice',
          level: 'info',
          message: t('notice.statusbarSet', { list: next.join(' ') || 'none' }),
        });
        await saveStatusBar(next).catch((err: Error) => {
          push({ kind: 'notice', level: 'warn', message: t('notice.statusbarSaveFailed', { message: err.message }) });
        });
        break;
      }

      case 'provider': {
        if (!arg) {
          push({
            kind: 'notice',
            level: 'info',
            message: t('notice.providers', {
              list: BUILTIN_PROVIDER_IDS.join(', '),
              current: session.provider.id,
            }),
          });
          break;
        }
        try {
          const next = await session.switch({ provider: arg });
          setProviderLabel(next.label);
          setModel(next.model);
          setThink(next.reasoningEffort);
          setUsage((prev) => ({ ...prev, window: next.contextWindow }));
          push({ kind: 'divider', label: t('divider.switched', { label: next.label, model: next.model }) });
          await saveProviderChoice(next.id).catch((err: Error) => {
            push({ kind: 'notice', level: 'warn', message: t('notice.providerSaveFailed', { message: err.message }) });
          });
        } catch (err) {
          push({ kind: 'error', message: (err as Error).message });
        }
        break;
      }

      case 'model': {
        if (!arg) {
          setWork({ phase: 'listingModels', since: Date.now() });
          try {
            const models = await session.listModels();
            push({
              kind: 'notice',
              level: 'info',
              message: `${t('notice.modelsOn', { label: session.provider.label })}\n${models
                .map((m) => `  ${m.id}`)
                .join('\n')}`,
            });
          } catch (err) {
            push({ kind: 'error', message: (err as Error).message });
          }
          endWork();
          break;
        }
        try {
          const next = await session.switch({ model: arg });
          setModel(next.model);
          setThink(next.reasoningEffort);
          setUsage((prev) => ({ ...prev, window: next.contextWindow }));
          push({ kind: 'divider', label: t('divider.modelNow', { model: next.model }) });
          await saveModelChoice(next.id, next.model).catch((err: Error) => {
            push({ kind: 'notice', level: 'warn', message: t('notice.modelSaveFailed', { message: err.message }) });
          });
        } catch (err) {
          push({ kind: 'error', message: (err as Error).message });
        }
        break;
      }

      case 'mcp':
        push({
          kind: 'notice',
          level: 'info',
          message:
            session.mcpStatuses.length === 0
              ? t('notice.mcpNone')
              : session.mcpStatuses
                  .map((s) =>
                    s.connected
                      ? `  ${glyphs.done} ${s.name} — ${t('notice.mcpTools', { n: s.toolCount })}`
                      : `  ${glyphs.failed} ${s.name} — ${s.error ?? '?'}`,
                  )
                  .join('\n'),
        });
        break;

      // 体检读的是会话此刻的配置(含 /approvals、/model 改过的值),MCP 直接
      // 采信已连上的状态——重新连一遍会把每个 stdio server 的子进程再拉起
      // 一份。`/doctor offline` 跳过联网那两项(端点探测、版本比对)。
      case 'doctor': {
        const offline = arg.trim() === 'offline';
        push({ kind: 'notice', level: 'info', message: t('notice.doctorRunning') });
        try {
          // 体检在会话所在的进程里跑(远程会话时是 server 侧):读的是会话
          // 此刻的配置,MCP 采信已连上的状态,已拉起的 LSP 不再重复握手。
          const report = await session.doctor({ offline });
          push({
            kind: 'notice',
            level: report.healthy ? 'info' : 'warn',
            // 不上色:notice 整段由 Timeline 按 level 着色,再嵌一层 ANSI
            // 会和它打架;✓ / ! / ✗ 三个符号已经能区分轻重。
            message: formatDoctor(report).trimEnd(),
          });
        } catch (err) {
          push({ kind: 'error', message: (err as Error).message });
        }
        break;
      }

      case 'cost':
        push({
          kind: 'notice',
          level: 'info',
          message:
            `${t('notice.costSession', { total: usage().total })}\n` +
            `${t('notice.costContext', { used: usage().used, window: usage().window })}\n` +
            t('notice.costTranscript', { path: `~/.mojocode/sessions/${session.store.id}.jsonl` }),
        });
        break;

      // 与 Claude Code 一致:把当前对话分叉进一个新会话 id 并切换过去。
      // 屏幕上什么都不变——历史、todos、权限全部照旧,只是从此写入新文件;
      // 源会话停在分叉点,之后可用 /resume 回去走另一条线。
      case 'fork': {
        const fromId = session.store.id;
        try {
          const forked = await session.forkSession();
          push({
            kind: 'notice',
            level: 'info',
            message: t('notice.forked', { id: forked.id, from: fromId.slice(0, 8) }),
          });
        } catch (err) {
          push({
            kind: 'notice',
            level: 'warn',
            message: t('notice.forkFailed', { message: (err as Error).message }),
          });
        }
        break;
      }

      case 'resume': {
        // 无参提交(如本工作区没有其他会话,选择器空表单直接回车)。
        if (!arg) {
          push({ kind: 'notice', level: 'info', message: t('cli.noSessions') });
          break;
        }
        let providerWarn: string | undefined;
        try {
          await session.resumeSession(arg);
        } catch (err) {
          if (err instanceof ProviderSwitchError) {
            // 历史已恢复,只是没切到会话记录的 provider/model。
            providerWarn = err.message;
          } else {
            push({
              kind: 'notice',
              level: 'warn',
              message: t('notice.resumeFailed', { message: (err as Error).message }),
            });
            break;
          }
        }
        // 横幅取 session 值而非 state 镜像:resumeSession 可能刚改写了
        // provider/model/权限,镜像要到下面的 set 之后才追上。
        resetTimeline([sessionBanner(session), ...buildResumeItems(session)]);
        // 同步 UI 状态:权限/provider/model 可能都被恢复改写;上下文用量
        // 归零,下一轮 step-end 会带回真实值。todos 由订阅自动更新。
        setPerms({ sandbox: session.config.sandbox, approval: session.config.approval });
        setPlanActive(session.config.plan);
        setProviderLabel(session.provider.label);
        setModel(session.provider.model);
        setThink(session.provider.reasoningEffort);
        setUsage({ used: 0, window: session.provider.contextWindow, total: 0 });
        if (providerWarn) {
          push({
            kind: 'notice',
            level: 'warn',
            message: t('notice.resumeProviderFailed', { message: providerWarn }),
          });
        }
        break;
      }

      default:
        push({ kind: 'notice', level: 'warn', message: t('notice.unknownCommand', { name: name ?? '' }) });
    }
  };

  // @ 文件补全的数据源:懒扫描 + TTL 缓存,注入给 Input。
  const fileLister = createFileLister(session.root);

  // 稳定引用:GoalLine 靠自己的秒表驱动,每次现读快照。
  const goalSnapshot = () => session.goal.snapshot();

  const handleSubmit = (text: string, pastedImages?: ImageAttachment[]) => {
    if (text.startsWith('/')) {
      void runCommand(text);
      return;
    }
    // 以 agent 的真实运行状态为准,不依赖可能滞后的渲染状态。展开
    // @ 引用是异步的,空闲时先亮起运行态保住提交的即时反馈。
    if (!session.agent.isRunning && !session.goal.busy) setRunning(true);
    // 回车之后、run() 之前有一段 agent 仍是 idle 的窗口。不标记的话,
    // 这期间 esc 会去武装回退选择器而不是取消,/clear 之类命令也会绕过
    // busy 拦截把历史换掉,随后排队的这一轮再往新会话里写。
    const gen = ++submitGen;
    submitPending = true;
    void (async () => {
      let expanded = text;
      const images: ImageAttachment[] = [...(pastedImages ?? [])];
      try {
        const result = await expandAtReferences(text, {
          root: session.root,
          denyPath: session.config.permissions.denyPath,
        });
        expanded = result.expanded;
        images.push(...result.images);
        const warnable = warnableSkips(result);
        if (warnable.length > 0) {
          push({
            kind: 'notice',
            level: 'warn',
            message: t('notice.attachSkipped', {
              list: warnable.map((s) => `@${s.path} (${s.reason})`).join(', '),
            }),
          });
        }
      } catch {
        // 展开失败不阻塞提交:按原文发送,文件内容让模型自己用工具读。
      }
      // 展开期间按了 esc(或又提交了一次):这一轮作废,不再发起。
      if (submitGen !== gen) {
        if (!session.agent.isRunning && !session.goal.busy) setRunning(false);
        return;
      }
      submitPending = false;
      // deepseek SDK 会静默丢弃图片 part(只发无人读的 warning),
      // 用户不提示的话会以为模型看到了图。
      if (images.length > 0 && session.provider.sdk === 'deepseek') {
        push({ kind: 'notice', level: 'warn', message: t('notice.providerNoVision') });
      }
      // 工作中提交 → 注入进行中的一轮作为引导;时间线显示原文。inject
      // 落空(展开期间那一轮恰好结束)则顺势降级为新一轮。
      if (await session.agent.inject(expanded, images.length > 0 ? images : undefined)) {
        push({ kind: 'user', text });
        push({ kind: 'notice', level: 'info', message: t('notice.guidanceQueued') });
        return;
      }
      // 目标循环的评估窗口里 agent 是空闲的,inject 会落空。这条消息不能
      // 另起一轮去和循环抢 agent(那会让循环随后的 run 退化成 inject 立刻
      // 返回,循环把它当成"一轮 0 毫秒跑完了",一边流式输出一边空转评估)。
      // 交给目标控制器,作为下一轮的指令取代评估器的引导。
      const runOptions = {
        ...(expanded !== text ? { display: text } : {}),
        ...(images.length > 0 ? { images } : {}),
      };
      if (await session.goal.steer(expanded, runOptions)) {
        // 这里**不**回显用户消息:与 inject 那条路不同,这条最终是经
        // agent.run 发出去的,会发 turn-start,时间线届时自己回显一次。
        // 两边都推的话会出现两条用户气泡。
        push({ kind: 'notice', level: 'info', message: t('notice.goalSteered') });
        return;
      }
      setRunning(true);
      // 经 goal.run 而不是 agent.run:没有目标时它就是原样透传,有目标时
      // 由它接管后续的评估与自动续跑,setRunning(false) 也因此只在整个
      // 循环结束时才触发,状态行在自动续跑期间保持常亮。
      await session.goal
        .run(expanded, Object.keys(runOptions).length > 0 ? runOptions : undefined)
        .finally(() => setRunning(false));
    })().catch((err: Error) => {
      // agent.run / goal.run 自身不 reject,但 inject / steer / run 在
      // client-server 模式下都是 RPC:server 抖一下(HTTP 错误、协议错误、
      // 连接断开)就会 reject,而这里是个 void 的异步 IIFE——未捕获的
      // rejection 在 Node ≥20 / Bun 下直接掀掉整个 TUI。与 /init、/plan、
      // /goal 三处同一条教训,这条提交路径在方法变成异步后被漏掉了。
      submitPending = false;
      setRunning(false);
      push({ kind: 'error', message: err.message });
    });
  };

  // 枚举参数的取值来源:在命令菜单上回车会进入二级选择器。
  // locale() 进依赖:/lang 切换后菜单文案立刻换语言。
  const commands = createMemo<SlashCommand[]>(() => {
    locale();
    const optionSources: Record<string, SlashCommand['options']> = {
      approvals: () =>
        APPROVAL_PRESETS.map((p) => ({
          value: p.id,
          label: t(PRESET_DESCRIPTIONS[p.id]),
          current: !planActive() && p.id === permissionsLabel(perms()),
        })),
      think: () =>
        supportedEfforts(session.provider).map((l) => ({
          value: l,
          label: t(THINK_DESCRIPTIONS[l]),
          current: l === think(),
        })),
      lang: () =>
        LOCALES.map((l) => ({ value: l, label: LOCALE_LABELS[l], current: l === locale() })),
      statusbar: () =>
        STATUS_SEGMENTS.map((s) => ({
          value: s,
          label: t(SEGMENT_DESCRIPTIONS[s]),
          current: statusSegments().includes(s),
        })),
      focus: () =>
        TIMELINE_MODES.map((m) => ({
          value: m,
          label: t(FOCUS_DESCRIPTIONS[m]),
          current: m === timelineMode(),
        })),
      provider: () =>
        BUILTIN_PROVIDER_IDS.map((id) => ({
          value: id,
          label: PROVIDER_PRESETS[id].label,
          current: id === session.provider.id,
        })),
      model: async (): Promise<CommandOption[]> => {
        const models = await session.listModels();
        return models.map((m) => ({ value: m.id, current: m.id === model() }));
      },
      resume: async (): Promise<CommandOption[]> => {
        const metas = await SessionStore.list(session.root);
        return metas
          .filter((m) => m.id !== session.store.id)
          .map((m) => ({
            value: m.id.slice(0, 8),
            label:
              `${m.updatedAt.slice(0, 16).replace('T', ' ')} · ` +
              `${t('cli.msgs', { n: m.messageCount })}${m.title ? ` · ${m.title}` : ''}`,
          }));
      },
    };
    return buildCommands().map((c) => ({ ...c, options: optionSources[c.name] }));
  });

  // 工作中且有任务时,状态行下方挂实时任务面板(Claude Code 的 ctrl+t 面板);
  // 空闲时清单仍走 Footer 的单行摘要,面板不重复占位。
  const todoPanelActive = () => Boolean(work()) && todos().length > 0;
  const todoPanelVisible = () => todoPanelActive() && todoPanelOpen();

  // 预览行数仍要看终端高度:底部固定区(flexShrink 0,见 JSX)在矮终端上
  // 不能把输入框和权限选项顶出视口。留 12 行给输入框边框、状态栏、footer
  // 与各处 marginTop,剩余空间双预览均分,最少各 1 行。
  const previewBudget = () => Math.max(1, Math.floor((size.rows - 12) / 2));
  const textRows = () => Math.min(STREAM_PREVIEW_ROWS, previewBudget());
  const reasoningRows = () => Math.min(REASONING_PREVIEW_ROWS, previewBudget());

  // 退出 dump 的数据通道(见 Props.itemsRef)。始终存全量:dump 是留档,
  // 不跟随 /focus 的显示密度。
  createEffect(() => {
    if (props.itemsRef) props.itemsRef.current = items();
  });

  // /focus 过滤在渲染层做,items 数据全量保留——切换档位只是换谓词重画。
  const visibleItems = createMemo(() => collapseItems(items(), timelineMode()));

  // 界面 JSX 抽成函数,由下方 <Show keyed> 按 locale 重挂载:Solid 没有
  // "整树重渲染",/lang 切换后的静态文案(占位符、提示、footer 标签)只有
  // 重建 JSX 才会重新求值。信号都活在外层,重挂载不丢任何状态;代价是
  // Input 的草稿/历史清空、滚动位置回到粘底——对一个改语言的显式操作可接受。
  const body = () => (
    <Box flexDirection="column" width="100%" height="100%">
      {/* 时间线:粘底滚动,流式期间自动跟随,上滚回看自动解粘。条目定稿后
          不可变,<For> 按引用复用,Solid 细粒度更新下无重渲染开销;markdown
          按 (key, width) 缓存。 */}
      <ScrollArea>
        <For each={visibleItems()}>
          {(item) => <TimelineEntry item={item} columns={size.columns} />}
        </For>
      </ScrollArea>

      {/* 底部固定区不参与收缩:空间不足时塌缩的是上面的时间线视口,
          输入框与权限选项永远可见(矮终端保障,替代旧的 RESERVED_ROWS)。 */}
      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        <Show when={activeReasoning().trim()}>
          <Box marginTop={1} paddingRight={WIDTH_SAFETY}>
            <Text color={theme.dim} italic>
              {tailWithinRows(activeReasoning(), reasoningRows(), size.columns - WIDTH_SAFETY)}
            </Text>
          </Box>
        </Show>

        <Show when={activeText().trim()}>
          <Box marginTop={1}>
            <Text color={theme.assistant}>{glyphs.bullet} </Text>
            <Box flexDirection="column" flexGrow={1} paddingRight={WIDTH_SAFETY}>
              {/* 前缀 ● 占两列,预览宽度相应收窄。 */}
              <Markdown text={tailWithinRows(activeText(), textRows(), size.columns - 2 - WIDTH_SAFETY)} />
            </Box>
          </Box>
        </Show>

        <For each={activeTools()}>
          {(call) => {
            const label = toolDisplayName(call.toolName);
            // 子 agent 的实时进度:顶行贴步数,下面缩进画最近几条工具调用的
            // 轨迹。轨迹只存在于动态区,任务收尾即消失——过程随时看得见,
            // 时间线(回滚缓冲)仍然只留一行摘要。
            const progress = () => taskProgress()[call.callId];
            const trail = () => progress()?.recentCalls ?? [];
            // 顶行只报步数:正在跑的工具就是轨迹的末条,再写一遍是重复。
            // (事件里仍带 currentTool,给 --json 的消费方用。)
            const progressText = () =>
              progress() ? ` · ${t('ui.taskSteps', { n: progress()!.steps })}` : '';
            // 前缀 2 列 + 工具名 + 括号 2 列,截到单行以内。
            const args = () =>
              truncateWidth(
                formatToolInput(call.toolName, call.input),
                Math.max(20, size.columns - WIDTH_SAFETY - label.length - 6 - progressText().length),
              );
            return (
              <Box marginTop={1} flexDirection="column" paddingRight={WIDTH_SAFETY}>
                <Box>
                  <Text color={theme.tool}>{glyphs.running} </Text>
                  <Text bold>{label}</Text>
                  {/* 无参数的工具(todo)不画空括号,与时间线、headless 一致。 */}
                  <Show when={args()}>
                    <Text color={theme.dim}>({args()})</Text>
                  </Show>
                  <Show when={progressText()}>
                    <Text color={theme.dim}>{progressText()}</Text>
                  </Show>
                </Box>
                <For each={trail()}>
                  {(sub) => {
                    const subLabel = toolDisplayName(sub.toolName);
                    const subArgs = () =>
                      truncateWidth(
                        formatToolInput(sub.toolName, sub.input),
                        Math.max(20, size.columns - WIDTH_SAFETY - subLabel.length - 10),
                      );
                    return (
                      <Box paddingLeft={3}>
                        <Text color={theme.dim}>
                          {glyphs.branch} {subLabel}
                          {subArgs() ? `(${subArgs()})` : ''}
                        </Text>
                      </Box>
                    );
                  }}
                </For>
              </Box>
            );
          }}
        </For>

        {/* 工作状态行:主流 CLI 的位置——流式内容/工具行之下、输入框之上。 */}
        <Show when={work()}>
          <StatusLine
            phase={work()!.phase}
            detail={work()!.detail}
            since={work()!.since}
            todoHint={todoPanelActive() ? (todoPanelOpen() ? 'hide' : 'show') : undefined}
          />
        </Show>
        <Show when={todoPanelVisible()}>
          <TodoPanel todos={todos()} columns={size.columns} />
        </Show>

        <Show
          when={permission()}
          keyed
          fallback={
            <Show
              when={rewind()}
              keyed
              fallback={
                <Box flexDirection="column" marginTop={1}>
                  {/* 目标进度贴在输入框正上方靠右:一眼能看到跑到第几轮、花了多久,
                      而不必敲 /goal 去问。授权确认框或回退选择器打开时不渲染
                      (它们走的是这个三元的另外两支)。 */}
                  <Show when={goalActive()}>
                    <GoalLine snapshot={goalSnapshot} columns={size.columns} />
                  </Show>
                  <Input
                    onSubmit={handleSubmit}
                    disabled={false}
                    placeholder={
                      running() || work()
                        ? t('input.steer')
                        : planActive()
                          ? t('input.planPlaceholder')
                          : t('input.placeholder')
                    }
                    mode={modeLabel()}
                    busy={running() || Boolean(work())}
                    commands={commands()}
                    onEscape={handleEscape}
                    prefill={prefill()}
                    onPrefillConsumed={clearPrefill}
                    fileIndex={fileLister}
                    readClipboardImage={readClipboardImage}
                    onImageNotice={(message) => push({ kind: 'notice', level: 'warn', message })}
                  />
                  <Footer
                    contextUsed={usage().used}
                    contextWindow={usage().window}
                    cumulativeTokens={usage().total}
                    // 实时面板已在上方展开时,底栏不再重复一行摘要。
                    todos={todoPanelVisible() ? [] : todos()}
                    model={model()}
                    mode={modeLabel()}
                    root={session.root}
                    think={think()}
                    segments={statusSegments()}
                    notice={
                      ctrlCArmed()
                        ? t('status.ctrlcAgain')
                        : escArmed()
                          ? t('status.escAgainRewind')
                          : modeFlash()
                            ? t('status.modeCycled', { mode: modeFlash()! })
                            : focusFlash()
                              ? t('status.focusCycled', { mode: focusFlash()! })
                              : copyFlash() !== undefined
                                ? t('status.selectionCopied', { n: copyFlash()! })
                                : undefined
                    }
                  />
                </Box>
              }
            >
              {(entries: RewindEntry[]) => (
                <RewindPicker
                  entries={entries}
                  onPick={handleRewindPick}
                  onCancel={() => setRewind(undefined)}
                />
              )}
            </Show>
          }
        >
          {(request: PermissionRequest) => <PermissionPrompt request={request} onDecide={onDecide} />}
        </Show>
      </Box>
    </Box>
  );

  return (
    <Show when={locale()} keyed>
      {() => body()}
    </Show>
  );
}
