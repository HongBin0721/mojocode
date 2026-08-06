import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { Footer } from './Footer.js';
import { Input, formatCommandLabel, type CommandOption, type SlashCommand } from './Input.js';
import { StatusLine, type WorkPhase, type WorkState } from './StatusLine.js';
import { TodoPanel, todoPanelRows } from './TodoPanel.js';
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
import { splitCommitted, tailWithinRows } from './preview.js';
import type { ActiveToolCall, NewTimelineItem, TimelineItem } from './types.js';
import type {
  AgentEvent,
  GoalStopReason,
  PermissionDecision,
  PermissionRequest,
} from '../core/events.js';
import { ProviderSwitchError, type Session } from '../app/bootstrap.js';
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
  type ApprovalPresetId,
  type Permissions,
  type ReasoningEffort,
  type StatusSegment,
} from '../config/schema.js';
import { BUILTIN_PROVIDER_IDS, PROVIDER_PRESETS } from '../config/providers.js';
import {
  saveLanguage,
  savePermissions,
  saveModelChoice,
  saveProviderChoice,
  saveReasoningEffort,
  saveStatusBar,
} from '../config/save.js';
import { listModels } from '../model/registry.js';
import { supportedEfforts } from '../model/reasoning.js';
import { LOCALES, getLocale, isLocale, setLocale, t, type Locale, type MessageKey } from '../i18n/index.js';
import { INIT_PROMPT } from '../agent/init.js';
import { createFileLister } from '../app/file-index.js';
import { expandAtReferences, warnableSkips, type ImageAttachment } from '../app/attachments.js';
import { readClipboardImage } from '../app/clipboard.js';
import { formatDoctor, runDoctor } from '../app/doctor.js';

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
    { name: 'compact', description: t('cmd.compact') },
    { name: 'new', description: t('cmd.new') },
    { name: 'clear', description: t('cmd.clear') },
    { name: 'mcp', description: t('cmd.mcp') },
    { name: 'doctor', description: t('cmd.doctor') },
    { name: 'cost', description: t('cmd.cost') },
    { name: 'resume', description: t('cmd.resume') },
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
const BUSY_BLOCKED_COMMANDS = new Set(['new', 'clear', 'compact', 'model', 'provider', 'resume', 'init']);

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
 * 流式预览占用的终端行数上限。动态区域(预览 + 输入框 + 状态栏)的总高度
 * 一旦超过终端窗口高度,Ink 就擦不掉上一帧,每次重绘都会往回滚区漏一份
 * 旧帧。完整文本在 text-end 时会进入 <Static> 时间线,预览截断不丢内容。
 *
 * 思考不同:定稿只留一行"已思考 8.2s",正文**只在这个预览里出现过一次**,
 * 之后再无回看途径,所以行数给得比正文预览的道理更足——它是唯一的窗口。
 */
const STREAM_PREVIEW_ROWS = 5;
const REASONING_PREVIEW_ROWS = 5;
/** 留给状态行、输入框、信息栏、进行中的工具行和各处 marginTop 的余量。 */
const RESERVED_ROWS = 13;

/** 宽度拖动期间 <Static> 的空条目列表;模块级常量保证引用稳定。 */
const NO_ITEMS: TimelineItem[] = [];

/**
 * 宽度拖动期间在动态区实时渲染的时间线尾部条数。足够铺满一屏(更早的
 * 内容本来就在视口外),又给长会话的每次宽度变化重渲染封住了成本上限。
 */
const RESIZE_TAIL_ITEMS = 12;


let itemCounter = 0;
const nextKey = () => `item-${itemCounter++}`;

/**
 * 启动横幅条目:字段取自 session 的当前值。会话中途 /model、shift+tab
 * 改掉的值走 App 内的 bannerItem(那边读的是 state 镜像)。
 */
function sessionBanner(session: Session): TimelineItem {
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
function buildResumeItems(session: Session): TimelineItem[] {
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
  session: Session;
}

export function App({ session }: Props): React.ReactElement {
  const { exit } = useApp();
  const { stdout, write: writeStdout } = useStdout();

  // 惰性初始化:`mojocode -r` 恢复的会话在首帧就带着回放的历史时间线。
  // 横幅永远是第一条(见 types.ts 的 banner 注释)。
  const [items, setItems] = useState<TimelineItem[]>(() => [
    sessionBanner(session),
    ...buildResumeItems(session),
  ]);
  /**
   * 每次清空时间线时递增,作为 <Static> 的 key 强制重挂载。
   *
   * Ink 自己攒了一份 fullStaticOutput,只在 <Static> 节点身份变化时才重置,
   * 并会在任何撑出视口的帧、以及终端恢复时原样重播它。只把 items 置空不换
   * 节点身份,于是 /clear 之后随便来一帧高内容(大 diff 的授权框、窄窗口下
   * 的长预览)就会把清掉的整份记录重新打回屏幕。
   */
  const [staticEpoch, setStaticEpoch] = useState(0);
  // 终端宽度正在拖动调节中:时间线暂时从 <Static> 摘下,尾部条目改在动态区
  // 实时渲染,停稳后整体重放(见下方 resize 监听的注释)。
  const [resizing, setResizing] = useState(false);
  // 拖动期间每个宽度变化递增一次,专门用来触发重渲染;值本身不被读取。
  const [, setResizeTick] = useState(0);
  const [activeText, setActiveText] = useState('');
  const [activeReasoning, setActiveReasoning] = useState('');
  const [activeTools, setActiveTools] = useState<ActiveToolCall[]>([]);
  // 进行中的子 agent(task 工具)的进度,按 callId 键。tool-end 时清掉。
  const [taskProgress, setTaskProgress] = useState<
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
  const [permission, setPermission] = useState<PermissionRequest | undefined>();
  const [running, setRunning] = useState(false);
  // 工作状态:undefined 表示空闲(状态行隐藏)。since 在整轮工作中保持
  // 不变,阶段切换只更新文字和颜色,已用时连续累计。
  const [work, setWork] = useState<WorkState | undefined>(undefined);
  // 从 store 取初值:恢复会话时 restoreState 在 bootstrap 阶段就填好了
  // todos,那时还没有订阅者,只靠 subscribe 的话要等模型下次调 todo 工具
  // 才显示。
  const [todos, setTodos] = useState<TodoItem[]>(() => session.todos.get());
  // ctrl+t 折叠/展开工作中的实时任务面板;偏好保持整个会话。
  //
  // 默认关闭(与 Claude Code 一致):模型每次调 todo 工具,时间线上就多一条
  // 完整清单,而面板画的正是同一份当前状态——两者逐字相同、上下紧挨着,
  // 常驻会让屏幕上重复好几份同样的任务。平时看时间线的记录即可,需要盯
  // 实时进度时再按 ctrl+t 调出来(状态行一直提示这个快捷键)。
  const [todoPanelOpen, setTodoPanelOpen] = useState(false);
  const [usage, setUsage] = useState({ used: 0, window: session.provider.contextWindow, total: 0 });
  const [providerLabel, setProviderLabel] = useState(session.provider.label);
  const [model, setModel] = useState(session.provider.model);
  // 两轴权限 + plan 标志。UI 展示与判断都从这份镜像取,靠 permission-change
  // 事件与 bootstrap 同步。
  const [perms, setPerms] = useState<Permissions>({
    sandbox: session.config.sandbox,
    approval: session.config.approval,
  });
  const [planActive, setPlanActive] = useState(session.config.plan);
  // 有没有目标在身。只管"那一行要不要渲染";轮数与已用时由 GoalLine 自己
  // 按秒现取——目标循环两轮之间几十秒里 App 没有任何 state 变化,靠 props
  // 传快照会一直停在设定目标那一刻的数字。初值取 session:`mojocode -c`
  // 恢复的目标在首帧就该显示出来。
  const [goalActive, setGoalActive] = useState(session.goal.active);
  // 状态栏/头部显示的标签:plan 压过两轴。
  const modeLabel = planActive ? 'plan' : permissionsLabel(perms);
  const [think, setThink] = useState<ReasoningEffort>(session.provider.reasoningEffort);
  const [ctrlCArmed, setCtrlCArmed] = useState(false);
  const [locale, setLocaleState] = useState(getLocale());
  const [statusSegments, setStatusSegments] = useState<StatusSegment[]>(session.config.statusBar);
  // esc-esc 回退:第一次 esc 预备(footer 提示),第二次打开回退选择器。
  const [escArmed, setEscArmed] = useState(false);
  // shift+tab 切换后在状态栏短暂回显新档位:mode 段可能被 /statusbar 关掉,
  // Header 又只在默认档时不显示且早已滚出屏幕——没有这个回显,按下去会毫无反馈。
  const [modeFlash, setModeFlash] = useState<string | undefined>(undefined);
  const modeFlashTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const [rewind, setRewind] = useState<RewindEntry[] | undefined>(undefined);
  // 回退后预填输入框的内容;Input 写入后回调清空,避免它重挂载时二次覆盖
  // 用户的新草稿。
  const [prefill, setPrefill] = useState<{ text: string } | undefined>(undefined);
  const clearPrefill = useCallback(() => setPrefill(undefined), []);

  // 待处理的权限 resolver 放在 ref 里:resolve 它绝不能依赖于
  // 某次重新渲染是否已经发生。
  const resolvePermission = useRef<((decision: PermissionDecision) => void) | undefined>(undefined);

  // 流式累积的权威副本。事件处理器要在 setState 之外读写当前值
  // (在 updater 里调用 push 属于嵌套 setState,updater 可能被重复执行),
  // 中断/出错时也要靠它把残留内容定稿。
  const activeTextRef = useRef('');
  const activeReasoningRef = useRef('');
  // 本段思考的起始时刻,定稿那一行的耗时由它算出。undefined 表示当前没有
  // 进行中的思考块。
  const reasoningStartedAt = useRef<number | undefined>(undefined);

  // 当前流式文本块是否已有段落提前定稿(增量提交):后续片段渲染时
  // 不再带 ● 前缀,只缩进对齐。
  const textCommitted = useRef(false);

  // `tool-end` 不携带调用的输入,所以在 `tool-start` 时先记下来。
  const toolInputs = useRef(new Map<string, unknown>());

  // 本轮是否调用过 exit_plan。计划模式下收尾时没调过就要出声,见 turn-end。
  const planSubmitted = useRef(false);
  // 本轮**开始时**是否就在计划模式。轮中途 shift+tab 切进计划模式的那一轮
  // 不该被追问方案——用户压根没让它规划,警告只会莫名其妙。
  const planAtTurnStart = useRef(false);

  const ctrlCTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const escTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  /**
   * 已受理但尚未发起 run() 的提交(@ 引用展开是异步的)。这段窗口里
   * agent 仍是 idle,esc 与 busy 拦截都要把它当作"忙"看待;submitGen
   * 递增即作废在途提交。
   */
  const submitPending = useRef(false);
  const submitGen = useRef(0);

  const push = useCallback((item: NewTimelineItem) => {
    setItems((prev) => [...prev, { ...item, key: nextKey() } as TimelineItem]);
  }, []);

  // 阶段切换保留 since(已用时连续);空闲时进入新阶段则从现在起计时。
  const beginWork = useCallback((phase: WorkPhase, detail?: string) => {
    setWork((prev) => ({ phase, detail, since: prev?.since ?? Date.now() }));
  }, []);
  const endWork = useCallback(() => setWork(undefined), []);

  // 把 agent 的事件总线接入 React 状态。
  useEffect(() => {
    const flushText = () => {
      const text = activeTextRef.current;
      activeTextRef.current = '';
      setActiveText('');
      if (text.trim())
        push({ kind: 'assistant', text: text.trimEnd(), continuation: textCommitted.current });
      textCommitted.current = false;
    };
    // 定稿的只是一行"已思考 8.2s":正文在流式期间实时可见,进了 <Static>
    // 就再也擦不掉,整段留在回滚区只会淹没回复和工具记录。
    const flushReasoning = () => {
      const text = activeReasoningRef.current;
      const startedAt = reasoningStartedAt.current;
      activeReasoningRef.current = '';
      reasoningStartedAt.current = undefined;
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

    const off = session.bus.on((event: AgentEvent) => {
      switch (event.type) {
        case 'turn-start':
          push({ kind: 'user', text: event.display ?? event.userText });
          planSubmitted.current = false;
          planAtTurnStart.current = session.config.plan;
          // 新一轮从零开始计时,不沿用上一轮残留的 since。
          setWork({ phase: 'thinking', since: Date.now() });
          break;

        case 'text-delta': {
          activeTextRef.current += event.text;
          // 段落级增量提交:已被空行收尾的段落立即定稿进时间线,预览只留
          // 正在生成的尾段。动态区高度天然受控,已生成内容随时可回看。
          const { committed, rest } = splitCommitted(activeTextRef.current);
          if (committed) {
            push({ kind: 'assistant', text: committed, continuation: textCommitted.current });
            textCommitted.current = true;
            activeTextRef.current = rest;
          }
          setActiveText(activeTextRef.current);
          beginWork('responding');
          break;
        }
        case 'text-end':
          flushText();
          break;

        case 'reasoning-delta':
          // 计时从第一个增量起,而不是订阅 reasoning-start:后者未必所有
          // provider 都发,且首个增量到达前屏幕上本来也没有思考在显示。
          reasoningStartedAt.current ??= Date.now();
          activeReasoningRef.current += event.text;
          setActiveReasoning(activeReasoningRef.current);
          beginWork('thinking');
          break;
        case 'reasoning-end':
          flushReasoning();
          break;

        case 'tool-start':
          if (event.toolName === 'exit_plan') planSubmitted.current = true;
          toolInputs.current.set(event.callId, event.input);
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
          setActiveTools((prev) => prev.filter((t) => t.callId !== event.callId));
          setTaskProgress((prev) => {
            if (!(event.callId in prev)) return prev;
            const { [event.callId]: _gone, ...rest } = prev;
            return rest;
          });
          const input = toolInputs.current.get(event.callId);
          toolInputs.current.delete(event.callId);
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
        // 底栏会一直停在 plan。命令侧的手动同步是同值 setState,
        // React 视为无操作,留着不碍事。
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
          if (planAtTurnStart.current && session.config.plan && !planSubmitted.current) {
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
    });

    return off;
  }, [session.bus, push, beginWork, endWork]);

  useEffect(() => session.todos.subscribe(setTodos), [session.todos]);

  // 启动时就带着目标(`mojocode -c` 恢复的会话):bootstrap 在 App 挂载之前
  // 就 restore 过了,那条 goal-start 没人听见。这里补一次提示。只在挂载时跑
  // 一次,所以 TUI 内 /resume 恢复的目标仍由实时事件呈现,不会重复两条。
  useEffect(() => {
    const restored = session.goal.state;
    if (restored?.restored) {
      push({
        kind: 'notice',
        level: 'info',
        message: t('notice.goalRestored', { condition: restored.condition }),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 把权限门禁的询问回调桥接到确认提示组件。
  useEffect(() => {
    session.gate.setAsker((request) => {
      setPermission(request);
      return new Promise<PermissionDecision>((resolve) => {
        resolvePermission.current = resolve;
      });
    });
  }, [session.gate]);

  const onDecide = useCallback((decision: PermissionDecision) => {
    setPermission(undefined);
    // 决定之后 agent 继续跑,状态从"等待确认"回到"思考中";若拒绝导致
    // 回合结束,turn-end/aborted 会随后把状态清掉。
    setWork((prev) => (prev ? { phase: 'thinking', since: prev.since } : prev));
    const resolve = resolvePermission.current;
    resolvePermission.current = undefined;
    resolve?.(decision);
  }, []);

  // ctrl+c 无论何时都要能退出(包括权限确认框打开时),所以单独一个
  // 始终激活的处理器。依赖 cli.tsx 里 exitOnCtrlC: false——否则 ink 会在
  // useInput 之前吞掉这个按键,这里永远收不到。
  useInput((input, key) => {
    // shift+tab 循环切权限档位(ask → auto → plan),与 Claude Code /
    // Codex 的手感一致。full-access 刻意不在循环里。授权确认框开着时不接:
    // 那会在你决定"要不要放行这一次"的中途改掉规则本身。
    if (key.tab && key.shift && !permission) {
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
      if (modeFlashTimer.current) clearTimeout(modeFlashTimer.current);
      modeFlashTimer.current = setTimeout(() => setModeFlash(undefined), 2000);
      return;
    }
    if (key.ctrl && input === 't') {
      setTodoPanelOpen((open) => !open);
      return;
    }
    if (key.ctrl && input === 'c') {
      if (ctrlCArmed) {
        // 必须清掉待触发的定时器:cli.tsx 只设置 process.exitCode 而不调用
        // process.exit(),挂着的定时器会让事件循环多活 2 秒才退出。
        if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
        exit();
      } else {
        setCtrlCArmed(true);
        ctrlCTimer.current = setTimeout(() => setCtrlCArmed(false), 2000);
      }
    }
  });

  // 三个定时器都要清:cli.tsx 只设 process.exitCode 而不调 process.exit(),
  // 任何挂着的定时器都会让事件循环多活到它触发为止——按过 shift+tab 之后
  // 两秒内连按 ctrl+c 退出,进程会僵在那里等这个回显定时器。
  useEffect(() => () => {
    if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
    if (escTimer.current) clearTimeout(escTimer.current);
    if (modeFlashTimer.current) clearTimeout(modeFlashTimer.current);
  }, []);

  // 重建时间线时的横幅:与 sessionBanner 的区别是读 state 镜像,/model、
  // shift+tab 等会话中途的改动会反映进去。
  const bannerItem = useCallback(
    (): TimelineItem => ({
      key: nextKey(),
      kind: 'banner',
      providerLabel,
      model,
      root: session.root,
      mode: modeLabel,
      mcpSummary:
        session.mcpStatuses.length > 0
          ? `${session.mcpStatuses.filter((s) => s.connected).length}/${session.mcpStatuses.length}`
          : undefined,
    }),
    [providerLabel, model, modeLabel, session],
  );

  // 清屏 + 换 <Static> 身份 + 重放:/resume 与 esc-esc 回退共用。
  // 不清屏直接换内容的话,ink 攒下的 fullStaticOutput 会把旧时间线重播回来
  // (见 staticEpoch 的注释)。
  const resetTimeline = useCallback(
    (nextItems: TimelineItem[]) => {
      writeStdout('\x1b[2J\x1b[3J\x1b[H');
      setItems(nextItems);
      setStaticEpoch((epoch) => epoch + 1);
    },
    [writeStdout],
  );

  // 终端宽度变化时的时间线处理。<Static> 里的条目按定稿时的宽度排版、
  // 只打印一次;宽度一变,终端自己把这些历史行重新折行——表格框线被拦腰
  // 切碎,拖动过程中滚进回滚缓冲的旧动态帧(输入框边框)也留成鬼影。ink
  // 的 resize 处理只重画动态区,救不了 <Static> 那部分。
  //
  // 节奏是"开始时搬进动态区、停稳后放回 <Static>":首次宽度变化立即清屏、
  // 把时间线从 <Static> 摘下,改为在动态区渲染其尾部若干条(resizing 分支,
  // 见 JSX);此后每个宽度变化都触发一次 React 重渲染,尾部条目跟着按新
  // 宽度重排——动态区完全归 ink 掌控,重写包在同步输出(DEC 2026)里,
  // 内容全程可见、排版正确、几乎不闪。宽度停稳后再清屏、恢复条目并换
  // <Static> 身份,全部按最终宽度重放。之前试过两版:拖动期间节流清屏
  // 重放整份时间线,重画本身闪得比错乱还凶;拖动期间整条藏起来,又变成
  // 内容全程不可见。
  //
  // 只看列数:高度伸缩不影响已定稿行的折行,不值得为它清一次屏。
  useEffect(() => {
    if (!stdout) return;
    // 最后一次宽度变化后多久算"停稳"。太短会在慢速拖动中反复重放,太长
    // 则松手后时间线迟迟不回来。
    const SETTLE_MS = 200;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastColumns = stdout.columns;
    let dragging = false;
    const onResize = () => {
      if (stdout.columns === lastColumns) return;
      lastColumns = stdout.columns;
      if (!dragging) {
        dragging = true;
        writeStdout('\x1b[2J\x1b[3J\x1b[H');
        // 同一批 setState:摘下条目 + 换 <Static> 身份,让 ink 丢掉已累积
        // 的静态输出,否则拖动中随便一个撑出视口的帧会把旧时间线重播回来。
        setResizing(true);
        setStaticEpoch((epoch) => epoch + 1);
      } else {
        // 拖动进行中:每个宽度变化都要一次重渲染,动态区里的尾部条目才会
        // 按新宽度重排(ink 的 resize 只重排 yoga 布局,不重跑组件,
        // renderMarkdownAnsi 的输出不触发 React 渲染就不会更新)。
        setResizeTick((tick) => tick + 1);
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        dragging = false;
        writeStdout('\x1b[2J\x1b[3J\x1b[H');
        setResizing(false);
        setStaticEpoch((epoch) => epoch + 1);
      }, SETTLE_MS);
    };
    stdout.on('resize', onResize);
    return () => {
      clearTimeout(timer);
      stdout.off('resize', onResize);
    };
  }, [stdout, writeStdout]);

  /** esc 的总入口:运行中 → 中断;空闲二连 esc → 回退选择器。 */
  const handleEscape = useCallback(() => {
    // 提交已受理但 @ 引用还在展开(run 尚未发起):作废这一次提交。
    // 注意不能就此返回——运行中提交的是引导消息,此时按 esc 要的是中断
    // 那一轮,只取消引导会表现为"esc 没反应,状态栏却灭了"。
    if (submitPending.current) {
      submitGen.current++;
      submitPending.current = false;
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
    if (!escArmed) {
      setEscArmed(true);
      if (escTimer.current) clearTimeout(escTimer.current);
      escTimer.current = setTimeout(() => setEscArmed(false), 2000);
      return;
    }
    if (escTimer.current) clearTimeout(escTimer.current);
    setEscArmed(false);
    const entries = collectRewindEntries(session.agent.history);
    if (entries.length === 0) {
      push({ kind: 'notice', level: 'warn', message: t('notice.rewindNothing') });
      return;
    }
    setRewind(entries);
  }, [session, escArmed, push]);

  const handleRewindPick = useCallback(
    (entry: RewindEntry) => {
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
    },
    [session, push, resetTimeline, bannerItem],
  );


  const runCommand = useCallback(
    async (raw: string) => {
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
        submitPending.current ||
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
          if (name === 'clear') {
            // 必须走 ink 的 writeToStdout(useStdout().write)而不是直接写
            // process.stdout:它会先擦掉当前帧并重置 ink 的"上一帧"缓存,
            // 写入清屏序列(2J 清屏、3J 清回滚缓冲、H 归位)后再重画帧。
            // 直接写 stdout 的话 ink 不知道屏幕被清了——若下一帧输出内容
            // 恰好没变(如时间线本就为空),ink 会跳过重绘,屏幕停在全空。
            writeStdout('\x1b[2J\x1b[3J\x1b[H');
          }
          // 清空时间线,只留横幅,回到和启动时一致的界面。
          setItems([bannerItem()]);
          // 同时换掉 <Static> 的身份,让 ink 丢掉已累积的静态输出。
          setStaticEpoch((epoch) => epoch + 1);
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
          if (!canEverWrite(perms, planActive)) {
            push({
              kind: 'notice',
              level: 'warn',
              message: t('notice.initReadonly', { mode: modeLabel }),
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
          if (!planActive) {
            // read-only+never 进来的话批准后会提升到 ask,提前说明,免得用户
            // 以为设置被吞了。其余组合忠实还原,不必多话。
            if (!canEverWrite(perms, false)) {
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
          if (planActive) {
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
                mode: modeLabel,
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
              message: t('notice.thinkUsage', { list: valid.join('|'), level: think }),
            });
            break;
          }
          const level = parsed.data;
          // provider 与 agent 持有同一个 ResolvedProvider 对象,改字段即可让
          // 下一次 streamText 生效;同时写回内存配置,使 /model、/provider
          // 重新 resolve 时不丢失本次选择。
          session.provider.reasoningEffort = level;
          session.config.providers[session.provider.id] = {
            ...(session.config.providers[session.provider.id] ?? {}),
            reasoningEffort: level,
          };
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

        case 'statusbar': {
          const currentList = statusSegments.join(' ') || 'none';
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
            const next = session.switch({ provider: arg });
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
              const models = await listModels(session.provider);
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
            const next = session.switch({ model: arg });
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
            const report = await runDoctor({
              root: session.root,
              config: session.config,
              mcpStatuses: session.mcpStatuses,
              // 会话内已拉起的服务器直接采信状态;没拉起过的由 doctor 做一次
              // 真握手探测(探完即杀)。
              lspStatuses: session.lsp?.statuses(),
              offline,
            });
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
              `${t('notice.costSession', { total: usage.total })}\n` +
              `${t('notice.costContext', { used: usage.used, window: usage.window })}\n` +
              t('notice.costTranscript', { path: `~/.mojocode/sessions/${session.store.id}.jsonl` }),
          });
          break;

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
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, perms, planActive, modeLabel, think, usage, statusSegments, push, exit, writeStdout, resetTimeline, bannerItem],
  );

  // @ 文件补全的数据源:懒扫描 + TTL 缓存,注入给 Input。
  const fileLister = useMemo(() => createFileLister(session.root), [session]);

  // 稳定引用:GoalLine 靠自己的秒表驱动,不需要跟着 App 的每次 setState
  // 一起重渲染。(秒表本身不受影响——它的 effect 依赖是空数组。)
  const goalSnapshot = useCallback(() => session.goal.snapshot(), [session]);

  // 必须定义在 runCommand 之后并把它列进依赖:否则这里会永久捕获首次渲染
  // 的 runCommand,上面那串依赖形同虚设,命令永远读到启动时的状态快照。
  const handleSubmit = useCallback(
    (text: string, pastedImages?: ImageAttachment[]) => {
      if (text.startsWith('/')) {
        void runCommand(text);
        return;
      }
      // 以 agent 的真实运行状态为准,不依赖可能滞后的 React state。展开
      // @ 引用是异步的,空闲时先亮起运行态保住提交的即时反馈。
      if (!session.agent.isRunning && !session.goal.busy) setRunning(true);
      // 回车之后、run() 之前有一段 agent 仍是 idle 的窗口。不标记的话,
      // 这期间 esc 会去武装回退选择器而不是取消,/clear 之类命令也会绕过
      // busy 拦截把历史换掉,随后排队的这一轮再往新会话里写。
      const gen = ++submitGen.current;
      submitPending.current = true;
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
        if (submitGen.current !== gen) {
          if (!session.agent.isRunning && !session.goal.busy) setRunning(false);
          return;
        }
        submitPending.current = false;
        // deepseek SDK 会静默丢弃图片 part(只发无人读的 warning),
        // 用户不提示的话会以为模型看到了图。
        if (images.length > 0 && session.provider.sdk === 'deepseek') {
          push({ kind: 'notice', level: 'warn', message: t('notice.providerNoVision') });
        }
        // 工作中提交 → 注入进行中的一轮作为引导;时间线显示原文。inject
        // 落空(展开期间那一轮恰好结束)则顺势降级为新一轮。
        if (session.agent.inject(expanded, images.length > 0 ? images : undefined)) {
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
        if (session.goal.steer(expanded, runOptions)) {
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
      })();
    },
    [session, runCommand, push],
  );

  // 枚举参数的取值来源:在命令菜单上回车会进入二级选择器。
  const commands = useMemo<SlashCommand[]>(() => {
    const optionSources: Record<string, SlashCommand['options']> = {
      approvals: () =>
        APPROVAL_PRESETS.map((p) => ({
          value: p.id,
          label: t(PRESET_DESCRIPTIONS[p.id]),
          current: !planActive && p.id === permissionsLabel(perms),
        })),
      think: () =>
        supportedEfforts(session.provider).map((l) => ({
          value: l,
          label: t(THINK_DESCRIPTIONS[l]),
          current: l === think,
        })),
      lang: () =>
        LOCALES.map((l) => ({ value: l, label: LOCALE_LABELS[l], current: l === locale })),
      statusbar: () =>
        STATUS_SEGMENTS.map((s) => ({
          value: s,
          label: t(SEGMENT_DESCRIPTIONS[s]),
          current: statusSegments.includes(s),
        })),
      provider: () =>
        BUILTIN_PROVIDER_IDS.map((id) => ({
          value: id,
          label: PROVIDER_PRESETS[id].label,
          current: id === session.provider.id,
        })),
      model: async (): Promise<CommandOption[]> => {
        const models = await listModels(session.provider);
        return models.map((m) => ({ value: m.id, current: m.id === model }));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, perms, planActive, think, model, providerLabel, statusSegments, session]);

  // 工作中且有任务时,状态行下方挂实时任务面板(Claude Code 的 ctrl+t 面板);
  // 空闲时清单仍走 Footer 的单行摘要,面板不重复占位。
  const todoPanelActive = Boolean(work) && todos.length > 0;
  const todoPanelVisible = todoPanelActive && todoPanelOpen;

  // 预览高度按实际终端尺寸收敛,窄/矮窗口下也不会撑爆动态区域。
  // 任务面板同处动态区,它占的行也要从预算里扣掉。
  const columns = stdout?.columns ?? 80;
  const panelRows = todoPanelVisible ? todoPanelRows(todos).length : 0;
  // 目标进度那一行同处动态区,它占的一行也要从预算里扣掉——但它和输入框
  // 同属一个三元分支,授权确认框或回退选择器占着位置时压根不渲染。不带上
  // 这个条件的话,矮终端下弹确认框时预览会比实际可用空间少截一行。
  const goalLineVisible = goalActive && !permission && !rewind;
  const budget = Math.max(
    1,
    (stdout?.rows ?? 24) - RESERVED_ROWS - panelRows - (goalLineVisible ? 1 : 0),
  );
  const textRows = Math.min(STREAM_PREVIEW_ROWS, budget);
  const reasoningRows = Math.min(REASONING_PREVIEW_ROWS, budget);

  return (
    <Box flexDirection="column">
      {/* 已完成的条目只渲染一次,留在终端回滚缓冲区中。宽度拖动调节期间
          整体摘下(见 resize 监听),停稳后按最终宽度重放。 */}
      <Static key={staticEpoch} items={resizing ? NO_ITEMS : items}>
        {(item) => <TimelineEntry key={item.key} item={item} />}
      </Static>

      {/* 宽度拖动期间的时间线尾部:在动态区实时渲染,每次宽度变化随
          React 重渲染按新宽度重排,内容保持可见且不被终端折坏。 */}
      {resizing ? (
        <Box flexDirection="column">
          {items.slice(-RESIZE_TAIL_ITEMS).map((item) => (
            <TimelineEntry key={item.key} item={item} />
          ))}
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        {activeReasoning.trim() ? (
          <Box marginTop={1} paddingRight={WIDTH_SAFETY}>
            <Text color={theme.dim} italic>
              {tailWithinRows(activeReasoning, reasoningRows, columns - WIDTH_SAFETY)}
            </Text>
          </Box>
        ) : null}

        {activeText.trim() ? (
          <Box marginTop={1}>
            <Text color={theme.assistant}>{glyphs.bullet} </Text>
            <Box flexDirection="column" flexGrow={1} paddingRight={WIDTH_SAFETY}>
              {/* 前缀 ● 占两列,预览宽度相应收窄。 */}
              <Markdown text={tailWithinRows(activeText, textRows, columns - 2 - WIDTH_SAFETY)} />
            </Box>
          </Box>
        ) : null}

        {activeTools.map((call) => {
          const label = toolDisplayName(call.toolName);
          // 子 agent 的实时进度:顶行贴步数,下面缩进画最近几条工具调用的
          // 轨迹。轨迹只存在于动态区,任务收尾即消失——过程随时看得见,
          // 时间线(回滚缓冲)仍然只留一行摘要。
          const progress = taskProgress[call.callId];
          const trail = progress?.recentCalls ?? [];
          // 顶行只报步数:正在跑的工具就是轨迹的末条,再写一遍是重复。
          // (事件里仍带 currentTool,给 --json 的消费方用。)
          const progressText = progress
            ? ` · ${t('ui.taskSteps', { n: progress.steps })}`
            : '';
          // 前缀 2 列 + 工具名 + 括号 2 列,截到单行以内。
          const args = truncateWidth(
            formatToolInput(call.toolName, call.input),
            Math.max(20, columns - WIDTH_SAFETY - label.length - 6 - progressText.length),
          );
          return (
            <Box key={call.callId} marginTop={1} flexDirection="column" paddingRight={WIDTH_SAFETY}>
              <Box>
                <Text color={theme.tool}>{glyphs.running} </Text>
                <Text bold>{label}</Text>
                {/* 无参数的工具(todo)不画空括号,与时间线、headless 一致。 */}
                {args ? <Text color={theme.dim}>({args})</Text> : null}
                {progressText ? <Text color={theme.dim}>{progressText}</Text> : null}
              </Box>
              {trail.map((sub, index) => {
                const subLabel = toolDisplayName(sub.toolName);
                const subArgs = truncateWidth(
                  formatToolInput(sub.toolName, sub.input),
                  Math.max(20, columns - WIDTH_SAFETY - subLabel.length - 10),
                );
                return (
                  <Box key={index} paddingLeft={3}>
                    <Text color={theme.dim}>
                      {glyphs.branch} {subLabel}
                      {subArgs ? `(${subArgs})` : ''}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          );
        })}

        {/* 工作状态行:主流 CLI 的位置——流式内容/工具行之下、输入框之上。 */}
        {work ? (
          <StatusLine
            phase={work.phase}
            detail={work.detail}
            since={work.since}
            todoHint={todoPanelActive ? (todoPanelOpen ? 'hide' : 'show') : undefined}
          />
        ) : null}
        {todoPanelVisible ? <TodoPanel todos={todos} columns={columns} /> : null}

        {permission ? (
          <PermissionPrompt request={permission} onDecide={onDecide} />
        ) : rewind ? (
          <RewindPicker
            entries={rewind}
            onPick={handleRewindPick}
            onCancel={() => setRewind(undefined)}
          />
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {/* 目标进度贴在输入框正上方靠右:一眼能看到跑到第几轮、花了多久,
                而不必敲 /goal 去问。授权确认框或回退选择器打开时不渲染
                (它们走的是这个三元的另外两支)。 */}
            {goalActive ? <GoalLine snapshot={goalSnapshot} columns={columns} /> : null}
            <Input
              onSubmit={handleSubmit}
              disabled={false}
              placeholder={
                running || work
                  ? t('input.steer')
                  : planActive
                    ? t('input.planPlaceholder')
                    : t('input.placeholder')
              }
              mode={modeLabel}
              busy={running || Boolean(work)}
              commands={commands}
              onEscape={handleEscape}
              prefill={prefill}
              onPrefillConsumed={clearPrefill}
              fileIndex={fileLister}
              readClipboardImage={readClipboardImage}
              onImageNotice={(message) => push({ kind: 'notice', level: 'warn', message })}
            />
            <Footer
              contextUsed={usage.used}
              contextWindow={usage.window}
              cumulativeTokens={usage.total}
              // 实时面板已在上方展开时,底栏不再重复一行摘要。
              todos={todoPanelVisible ? [] : todos}
              model={model}
              mode={modeLabel}
              root={session.root}
              think={think}
              segments={statusSegments}
              notice={
                ctrlCArmed
                  ? t('status.ctrlcAgain')
                  : escArmed
                    ? t('status.escAgainRewind')
                    : modeFlash
                      ? t('status.modeCycled', { mode: modeFlash })
                      : undefined
              }
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}

