import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from 'solid-js';
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
import { SettingsPanel } from './SettingsPanel.js';
import { ModePicker, type ModeOption } from './ModePicker.js';
import type { TodoItem } from '../tools/index.js';
import {
  APPROVAL_PRESETS,
  canEverWrite,
  isDangerousPermissions,
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
import { BUILTIN_PROVIDER_IDS, PROVIDER_PRESETS, apiKeyFromEnv, isBuiltinProvider, type BuiltinProviderId } from '../config/providers.js';
import type { ResolvedProvider } from '../config/load.js';
import { ModelsPicker } from './ModelsPicker.js';
import { ProviderPicker, type ProviderRow } from './ProviderPicker.js';
import { listModels, type ProviderModels } from '../model/registry.js';
import { saveApiKey } from '../config/save.js';
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
import { getLocale, setLocale, t, type Locale, type MessageKey } from '../i18n/index.js';
import { INIT_PROMPT } from '../agent/init.js';
import { createFileLister } from '../app/file-index.js';
import { expandAtReferences, warnableSkips, type ImageAttachment } from '../app/attachments.js';
import { readClipboardImage } from '../app/clipboard.js';
import { formatDoctor } from '../app/doctor.js';

/** 每次渲染时重建,使 /setting 里的语言切换与配置中的语言设置都能生效。 */
/**
 * 把手打的别名(/model、/settings、/quit 这类,不经 Input 菜单的改写)
 * 归一为分发主名。别名的知识只住在 buildCommands 的表里:拦截表与
 * switch 都只见主名,给命令配别名时漏列任何一处都不再构成绕过。
 */
function canonicalCommandName(name: string): string {
  return buildCommands().find((c) => c.aliases?.includes(name))?.name ?? name;
}

function buildCommands(): SlashCommand[] {
  return [
    { name: 'help', description: t('cmd.help') },
    { name: 'init', description: t('cmd.init') },
    { name: 'plan', description: t('cmd.plan') },
    { name: 'goal', description: t('cmd.goal') },
    { name: 'models', aliases: ['model'], description: t('cmd.models') },
    { name: 'provider', description: t('cmd.provider') },
    { name: 'approvals', description: t('cmd.approvals') },
    { name: 'think', description: t('cmd.think') },
    { name: 'setting', aliases: ['settings'], description: t('cmd.setting') },
    { name: 'focus', description: t('cmd.focus') },
    { name: 'compact', description: t('cmd.compact') },
    { name: 'new', description: t('cmd.new') },
    { name: 'clear', description: t('cmd.clear') },
    { name: 'mcp', description: t('cmd.mcp') },
    { name: 'skills', description: t('cmd.skills') },
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

/** 运行中会和进行中的流互相踩踏的命令(改历史、换模型)。runCommand 入口
 * 已把别名归一为主名,这里只列主名。 */
const BUSY_BLOCKED_COMMANDS = new Set(['new', 'clear', 'compact', 'models', 'provider', 'resume', 'fork', 'init']);

/**
 * 压缩进度条的预估摘要总长(字符)。摘要提示词要的是分节的事实性散文,
 * 实测多落在 1500–4000 字符,取中偏上让条的走速与真实耗时大致相称。
 * 估算只影响观感:偏短=提前贴住 99%,偏长=收尾时从半程直接熄灯。
 */
const COMPACT_EXPECTED_SUMMARY_CHARS = 3000;

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

/**
 * 流式预览占用的终端行数上限。全屏布局下这不再是防漏帧的硬约束,只是
 * 思考尾部的滚动窗口行数。正文的活动条目在时间线里完整生长,不裁剪;
 * 思考不同——定稿只留一行"已思考 8.2s",正文**只在流式期间出现过一次**,
 * 之后要 ctrl+r 才展开,而思考动辄几千行,完整摊开会把 scrollbox 内容撑到
 * 天上、reasoning-end 时又整体塌掉。留一个几行的尾部窗口原地刷新即可。
 */
const REASONING_PREVIEW_ROWS = 5;


let itemCounter = 0;
const nextKey = () => `item-${itemCounter++}`;

/**
 * 启动横幅条目:字段取自 session 的当前值。会话中途 /models、shift+tab
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
 *
 * 回放读**展示历史**而不是模型历史:压缩把模型历史换成摘要+尾巴,但用户
 * 恢复会话该看到的是原始对话(与 opencode 一致)。`??` 兜底覆盖没有该字段
 * 的旧 server 镜像与测试桩——那时退回模型历史,摘要显示成一行压缩提示。
 */
function buildResumeItems(session: SessionHandle): TimelineItem[] {
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
  // /setting 设置面板(语言、状态栏)。开着时 Input 与 Footer 卸载,面板
  // 自带按键处理——与回退选择器同一套互斥渲染。
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  // 点底栏权限档位弹出的选项框。与设置面板同一套互斥渲染(Input/Footer 卸载)。
  const [modePickerOpen, setModePickerOpen] = createSignal(false);
  // esc-esc 回退:第一次 esc 预备(footer 提示),第二次打开回退选择器。
  const [escArmed, setEscArmed] = createSignal(false);
  // shift+tab 切换后在状态栏短暂回显新档位:mode 段可能在 /setting 里被关掉,
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
  // ctrl+r 的详情开关:思考正文与工具输出默认折叠,展开是全局的一档
  // (没有消息级导航,逐条展开没有可用的选中态)。同样给一次 footer 回显。
  const [detailsExpanded, setDetailsExpanded] = createSignal(false);
  const [expandFlash, setExpandFlash] = createSignal<boolean | undefined>(undefined);
  let expandFlashTimer: NodeJS.Timeout | undefined;
  // 拖选自动复制后的回显(字符数)。
  const [copyFlash, setCopyFlash] = createSignal<number | undefined>(undefined);
  let copyFlashTimer: NodeJS.Timeout | undefined;
  const [rewind, setRewind] = createSignal<RewindEntry[] | undefined>(undefined);
  // /models 与 /provider 的选择器(互斥渲染,同回退选择器)。/models 的分组
  // 数据在打开前拉好;单组失败在选择器里就地标注,手动输入行永远兜底。
  const [modelsPicker, setModelsPicker] = createSignal<ProviderModels[] | undefined>(undefined);
  const [providerPicker, setProviderPicker] = createSignal<ProviderRow[] | undefined>(undefined);
  // 回退后预填输入框的内容;Input 写入后回调清空,避免它重挂载时二次覆盖
  // 用户的新草稿。
  const [prefill, setPrefill] = createSignal<{ text: string } | undefined>(undefined);
  const clearPrefill = () => setPrefill(undefined);

  /**
   * 有覆盖层占着屏幕底部——授权确认框、回退选择器、档位选项框、设置面板、
   * 模型/厂商选择器取第一个成立的(见下方渲染处的 <Switch>)。它们渲染期间
   * Input 与 Footer 都已卸载,所以任何「靠 footer 回显反馈」的全局快捷键都要
   * 拿它挡一下。
   */
  const overlayOpen = () =>
    permission() !== undefined ||
    rewind() !== undefined ||
    settingsOpen() ||
    modePickerOpen() ||
    modelsPicker() !== undefined ||
    providerPicker() !== undefined;

  /**
   * 把两轴档位写进本工作区的 `.mojocode/config.json`(底栏选项框与 /approvals
   * 共用这一条落盘路径;shift+tab 不走,见 applyMode)。
   *
   * 落盘是尽力而为:写不进去只提示一句,本会话的档位早已生效,不该被一个
   * 写文件的失败拖住。返回配置文件路径,失败为 undefined。
   */
  const persistPermissions = async (next: Permissions): Promise<string | undefined> =>
    savePermissions(session.root, next).catch((err: Error) => {
      push({
        kind: 'notice',
        level: 'warn',
        message: t('notice.modeSaveFailed', { message: err.message }),
      });
      return undefined;
    });

  /**
   * 切到某一档权限(预设 id 或 'plan')。shift+tab 的循环、点击底栏弹出的
   * 选项框都归到这一个出口上。
   *
   * `persist` 由调用方点名,没有默认值:落盘改的是可提交的项目配置,新加一个
   * 入口时必须停下来想一次它算不算"用户点名指定了这一档"。
   * - 选项框(与 /approvals 同理):用户指着某一档选的,落盘,选一次管到下次启动。
   * - shift+tab:盲步进——按下去之前并不知道会落在哪一档,一次误触不该改写
   *   项目配置。尤其是从 plan 出来那一步,循环规定落到 read-only,那是"退出
   *   计划模式"的附带结果,不是用户对档位的表态;真按它落盘,项目里签入的
   *   `auto` 就被两下 tab 悄悄改成了 read-only。
   *
   * plan 任何情况下都不落盘——它是一次协作方式的选择(方案批准后就该还原),
   * 不是档位;存下来会让每个新会话都莫名其妙地开在计划模式里。
   */
  const applyMode = (id: ApprovalPresetId | 'plan', opts: { persist: boolean }) => {
    if (id === 'plan') {
      session.setPlan(true);
      setPlanActive(true);
    } else {
      const next = presetById(id);
      session.setPermissions(next);
      setPerms(next);
      setPlanActive(false);
      // full-access 绕过硬拒名单——只给底栏两秒的回显不够:得在时间线上留一条,
      // 事后翻记录也看得见这一段是在无沙箱下跑的。
      if (isDangerousPermissions(next)) {
        push({ kind: 'notice', level: 'warn', message: t('notice.modeDanger', { mode: id }) });
      }
      // 落盘的那条路要说出来:一次点选改掉了一个可提交的文件,不该只有底栏
      // 闪两秒。(/approvals 自己会提示,它不走这里。)
      if (opts.persist) {
        void persistPermissions(next).then((saved) => {
          if (saved) {
            push({
              kind: 'notice',
              level: 'info',
              message: t('notice.modeSavedTo', { path: saved }),
            });
          }
        });
      }
    }
    // 档位可能在 /setting 里被关掉、Header 又早已滚出屏幕,没有回显就等于
    // 没有反馈。
    setModeFlash(id);
    if (modeFlashTimer) clearTimeout(modeFlashTimer);
    modeFlashTimer = setTimeout(() => setModeFlash(undefined), 2000);
  };

  /**
   * 权限档位循环一步(read-only → ask → auto → full-access → plan → read-only)。
   * 只改本会话,不落盘:盲步进的落点不算用户对档位的表态(见 applyMode)。
   *
   * 调用方负责挡住覆盖层打开时的情形:授权确认框开着时改规则,等于在"要不要
   * 放行这一次"的中途改掉规则本身;其余覆盖层渲染期间 Footer 已卸载,切了档位
   * 没有任何反馈。
   */
  const cycleMode = () => {
    const step = nextCycleStep(
      { sandbox: session.config.sandbox, approval: session.config.approval },
      session.config.plan,
    );
    applyMode('plan' in step ? 'plan' : step.preset, { persist: false });
  };

  /**
   * 底栏档位的选项框(点一下弹出)。它比 shift+tab 多的是"由你指定落在哪一档"
   * ——正因为是点名指定的,这一档会落盘到本工作区,选一次管到下次启动。
   * plan 与四个预设并列列出:底栏那一段显示的就是这五种取值。
   */
  const modeOptions = (): ModeOption[] => [
    ...APPROVAL_PRESETS.map((p) => ({
      id: p.id as string,
      label: t(PRESET_DESCRIPTIONS[p.id]),
      current: !planActive() && p.id === permissionsLabel(perms()),
    })),
    { id: 'plan', label: t('approvalopt.plan'), current: planActive() },
  ];

  const pickMode = (id: string) => {
    setModePickerOpen(false);
    applyMode(id as ApprovalPresetId | 'plan', { persist: true });
  };

  /**
   * 弹出授权确认框,并关掉被它抢占的那些覆盖层。
   *
   * 确认框在 <Switch> 里优先级最高,底下几个只是渲染不出来、信号还开着——
   * 不就地关掉的话,用户决定完确认框它们就"复活"盖在输入框上,那时一个下意识
   * 的回车按到的是它们的确认动作(改权限档位 / 回退到某条消息 / 进设置分区 /
   * 切模型或厂商),而不是提交消息。回退那一支尤其严重:它会截断历史。
   *
   * 关掉等价于按 esc:它们都只有游标和草稿这类本地状态,丢弃即可。
   */
  const showPermission = (request: PermissionRequest) => {
    setModePickerOpen(false);
    setSettingsOpen(false);
    setRewind(undefined);
    setModelsPicker(undefined);
    setProviderPicker(undefined);
    setPermission(request);
  };

  // 待处理的权限 resolver。Solid 下就是普通变量:处理器读的永远是当前值。
  let resolvePermission: ((decision: PermissionDecision) => void) | undefined;

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
            showPermission(event.request);
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
                model: model(),
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

  {
    const off = session.todos.subscribe(setTodos);
    onCleanup(off);
  }

  // 技能列表变化(新增/删除 SKILL.md、/skills 强制重扫)时 bump 信号,
  // 驱动 commands memo 重算,`/` 菜单跟着刷新。
  const [skillsTick, setSkillsTick] = createSignal(0);
  {
    const off = session.skillsChanged(() => setSkillsTick((n) => n + 1));
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
    showPermission(request);
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
    // 其余覆盖层(回退选择器、设置面板)打开时同样不接:它们渲染期间 Footer
    // 已卸载,切了档位没有任何反馈,之后的写操作会在用户不知情的模式下放行。
    if (key.tab && key.shift && !overlayOpen()) {
      cycleMode();
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
    // ctrl+r 展开/收起详情(思考正文、工具输出)。与 ctrl+o 同理:全屏
    // 渲染下切换只是换参数重画,随时双向可逆。
    if (key.ctrl && input === 'r') {
      const next = !detailsExpanded();
      setDetailsExpanded(next);
      setExpandFlash(next);
      if (expandFlashTimer) clearTimeout(expandFlashTimer);
      expandFlashTimer = setTimeout(() => setExpandFlash(undefined), 2000);
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
    if (expandFlashTimer) clearTimeout(expandFlashTimer);
    if (copyFlashTimer) clearTimeout(copyFlashTimer);
  });

  // 拖选松手自动复制到剪贴板(kit.useSelectionCopy),footer 回显字符数。
  useSelectionCopy((chars) => {
    setCopyFlash(chars);
    if (copyFlashTimer) clearTimeout(copyFlashTimer);
    copyFlashTimer = setTimeout(() => setCopyFlash(undefined), 2000);
  });

  // 重建时间线时的横幅:与 sessionBanner 的区别是读 state 镜像,/models、
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
    // 回放用的展示历史必须在 setHistory **之前**算:截掉的是尾部 k 条,而
    // 压缩后模型历史的尾部与展示历史的尾部是同一批消息(reconcileDisplay 的
    // rewind 分支同理),所以两边都去掉 k 条。之后再读就不确定了——远程镜像
    // 的 setHistory 会当场截,本地 store 要等 save 落盘才前进。
    // 用模型历史重放会把压缩前的原始对话换成一行「已压缩」提示(store 里
    // 明明还留着,下次 /resume 又会出现)。
    const removed = session.agent.history.length - entry.index;
    const display = session.store.displayMessages ?? session.agent.history;
    const displayAfter =
      removed > 0 && removed <= display.length
        ? display.slice(0, display.length - removed)
        : display;

    // 截断到目标消息之前;setHistory 会递增 historyGeneration,顺带作废
    // 任何在途压缩的结果。store.save 的引用前缀比较失败 → 自动落 snapshot。
    session.agent.setHistory(session.agent.history.slice(0, entry.index));
    void session.store.save(session.agent.history).catch((err: Error) => {
      push({ kind: 'notice', level: 'warn', message: t('notice.sessionSaveFailed', { message: err.message }) });
    });
    const replayed = replayTimeline(displayAfter).map(
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

  /**
   * 设置面板选定语言。setLocaleState 会让整棵界面树按新 locale 重挂载
   * (见文件末尾的 keyed Show),所以提示文案在切换之后才取——那句话本身
   * 就该用新语言说。
   */
  const applyLanguage = (next: Locale) => {
    if (next === locale()) return;
    setLocale(next);
    setLocaleState(next);
    push({ kind: 'notice', level: 'info', message: t('notice.langSet', { lang: next }) });
    void saveLanguage(next).catch((err: Error) => {
      push({ kind: 'notice', level: 'warn', message: t('notice.langSaveFailed', { message: err.message }) });
    });
  };

  /** 设置面板确认状态栏信息段(面板已按 STATUS_SEGMENTS 顺序规范化)。 */
  const applyStatusBar = (next: StatusSegment[]) => {
    setStatusSegments(next);
    session.config.statusBar = next;
    push({
      kind: 'notice',
      level: 'info',
      // 空状态栏用与面板同一个词(中文下是「无」),别一边写「无」一边写 none。
      message: t('notice.statusbarSet', { list: next.join(' ') || t('settings.none') }),
    });
    void saveStatusBar(next).catch((err: Error) => {
      push({ kind: 'notice', level: 'warn', message: t('notice.statusbarSaveFailed', { message: err.message }) });
    });
  };

  /**
   * `session.switch` 返回后的统一落地:刷新镜像、按"厂商是否变化"选分隔线
   * 文案、厂商变化时把默认厂商落盘。/provider 与 /models 两条路径共用——
   * "switch 之后必须发生什么"这份后果清单只允许有一份。
   *
   * changed 由调用方给定:/provider 一律视作切换(重选当前厂商也重新钉一
   * 遍),/models 按厂商实际变没变算。persistModel 只在用户显式选了模型时
   * 为真——/provider 的模型是回退解析出来的,不落盘。
   */
  const landSwitch = async (
    next: ResolvedProvider,
    changed: boolean,
    persistModel: boolean,
  ): Promise<void> => {
    if (changed) setProviderLabel(next.label);
    setModel(next.model);
    setThink(next.reasoningEffort);
    setUsage((prev) => ({ ...prev, window: next.contextWindow }));
    push({
      kind: 'divider',
      label: changed
        ? t('divider.switched', { label: next.label, model: next.model })
        : t('divider.modelNow', { model: next.model }),
    });
    if (changed) {
      await saveProviderChoice(next.id).catch((err: Error) => {
        push({ kind: 'notice', level: 'warn', message: t('notice.providerSaveFailed', { message: err.message }) });
      });
    }
    if (persistModel) {
      await saveModelChoice(next.id, next.model).catch((err: Error) => {
        push({ kind: 'notice', level: 'warn', message: t('notice.modelSaveFailed', { message: err.message }) });
      });
    }
  };

  /**
   * `/models <id>`(当前厂商)与分组选择器共用的切换落地。
   *
   * providerId 只在用户**显式点名**厂商(分组选择器里选了某组的行)时传:
   * 文本参数路径必须只发 { model },让 server 按它的实时 provider 解析——
   * 共享会话下 client 的 provider 镜像可能滞后,拿镜像值钉死会把别的
   * client 刚切过去的厂商又翻回来。
   */
  const applyModelSwitch = async (providerId: string | undefined, modelId: string): Promise<void> => {
    try {
      // 上一家厂商要在 switch 之前取:本地 Session 切完 provider 就地更新,
      // 远程镜像也会在 refreshState 后跟上,事后比是恒等的。
      const previousId = session.provider.id;
      const next = await session.switch(
        providerId ? { provider: providerId, model: modelId } : { model: modelId },
      );
      await landSwitch(next, next.id !== previousId, true);
    } catch (err) {
      push({ kind: 'error', message: (err as Error).message });
    }
  };

  /**
   * `/provider <id>` 与厂商选择器共用的切换落地。apiKey 只在"选择器里就地
   * 输入并验证(或强行保存)了新 key"时出现:先落盘,再随 switch 送到真正
   * 跑模型的进程(远程模式下 server 的内存配置看不到刚写进文件里的 key)。
   */
  const applyProviderSwitch = async (id: string, apiKey?: string): Promise<void> => {
    try {
      if (apiKey) {
        await saveApiKey(id, apiKey).catch((err: Error) => {
          push({ kind: 'notice', level: 'warn', message: t('notice.providerSaveFailed', { message: err.message }) });
        });
      }
      const next = await session.switch(apiKey ? { provider: id, apiKey } : { provider: id });
      await landSwitch(next, true, false);
    } catch (err) {
      push({ kind: 'error', message: (err as Error).message });
    }
  };

  /**
   * 厂商选择器的行数据:内置预设 + 配置文件里的自定义条目,标 ✓ 与有无 key。
   *
   * key 的有无一律按**字段存在**判断而不是真值:默认 client-server 模式下
   * session.config 是 redactConfig 过的镜像,配置文件里的 apiKey 被抹成 ''
   * (字段保留)——按真值判会把向导配好的每个厂商都标成 no key 逼用户重输。
   */
  const providerRows = (): ProviderRow[] => {
    const configured = session.config.providers;
    const rows: ProviderRow[] = BUILTIN_PROVIDER_IDS.map((id) => {
      const preset = PROVIDER_PRESETS[id];
      return {
        id,
        label: preset.label,
        baseURL: preset.baseURL,
        keyUrl: preset.keyUrl,
        hasKey:
          apiKeyFromEnv(preset.apiKeyEnv) !== undefined || configured[id]?.apiKey !== undefined,
        current: id === session.provider.id,
      };
    });
    for (const [id, def] of Object.entries(configured)) {
      if (isBuiltinProvider(id) || !def.baseURL) continue;
      rows.push({
        id,
        label: def.label ?? id,
        baseURL: def.baseURL,
        hasKey:
          def.apiKey !== undefined ||
          (def.apiKeyEnv ? apiKeyFromEnv([def.apiKeyEnv]) !== undefined : false),
        current: id === session.provider.id,
        // 自定义端点默认允许无凭据(本地服务);声明了 apiKeyEnv 的除外。
        keyOptional: def.apiKeyEnv === undefined,
      });
    }
    return rows;
  };

  /**
   * 厂商选择器的 key 探针:在本进程直接打 /models(纯 HTTP,不经会话)。
   * 抛错即验证失败,由 ProviderPicker 展示并给出重试/强存;signal 让
   * 验证中按 esc 能真正掐断挂起的请求。
   */
  const probeProviderKey = (id: string, key: string, signal?: AbortSignal): Promise<number> => {
    const preset = isBuiltinProvider(id) ? PROVIDER_PRESETS[id as BuiltinProviderId] : undefined;
    const override = session.config.providers[id];
    // override 优先——与 resolveProvider 同序:用户给内置厂商配了代理 baseURL
    // 时,拿代理签发的 key 去打官方端点必然 401,验证会拒掉一把好 key。
    const baseURL = override?.baseURL ?? preset?.baseURL;
    if (!baseURL) return Promise.reject(new Error(`Unknown provider "${id}"`));
    return listModels(
      {
        id,
        label: preset?.label ?? override?.label ?? id,
        baseURL,
        apiKey: key,
        model: preset?.defaultModel ?? 'custom',
        headers: override?.headers ?? {},
        contextWindow: preset?.defaultContextWindow ?? 128_000,
        parallelToolCalls: true,
        reasoningEffort: 'auto',
        sdk: 'openai-compatible',
      },
      signal ? { signal } : {},
    ).then((models) => models.length);
  };

  const runCommand = async (raw: string) => {
    const [typed, ...rest] = raw.slice(1).trim().split(/\s+/);
    // 别名先归一为主名(未知的命令保持原样,走 default 分支的提示)。
    const name = typed ? canonicalCommandName(typed) : undefined;
    const arg = rest.join(' ');

    // 这些命令会改写正在被进行中的流读写的历史/模型,运行中禁止。
    // 压缩没有 controller,isRunning 期间为 false——不把它算进来的话,
    // /compact 等待摘要返回时还能执行 /clear,压缩随后会把已丢弃的对话
    // 写回内存,并存进那个全新的会话文件。
    // goal.busy 必须并进来:目标循环两轮之间的评估窗口里 agent 是空闲的,
    // 但历史随时会被下一轮接着写——不算作忙的话,`/clear`、`/models`、
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

      // (/quit 别名已在 runCommand 入口归一为 exit。)
      case 'exit':
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
        // full-access 绕过硬拒名单,而且和别的档位一样会留到下次启动——
        // 时间线上必须留一条,事后翻记录能认出这一段跑在无沙箱下。
        if (isDangerousPermissions(next)) {
          push({
            kind: 'notice',
            level: 'warn',
            message: t('notice.modeDanger', { mode: preset.id }),
          });
        }
        // 落盘范围是本工作区的 .mojocode/config.json,不碰全局配置。
        const saved = await persistPermissions(next);
        if (saved) {
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

      // 设置面板:语言与状态栏都收在这里(旧的 /lang、/statusbar 已并入)。
      // 面板自己带按键处理,命令只负责把它打开。
      //
      // 刻意不进 BUSY_BLOCKED_COMMANDS:面板只改显示层,碰不到进行中的流。
      // 代价是它开着时 Input 卸载,想插话引导得先 esc 关掉面板。
      // (/settings 别名已在 runCommand 入口归一为 setting。)
      case 'setting':
        setSettingsOpen(true);
        break;

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

      case 'provider': {
        if (!arg) {
          // 无参数:打开厂商选择器——已配 key 的 ✓ 即切,未配的就地输入验证。
          setProviderPicker(providerRows());
          break;
        }
        await applyProviderSwitch(arg);
        break;
      }

      case 'models': {
        if (!arg) {
          // 无参数:并发拉取所有已配置厂商的模型列表,打开分组选择器。
          // 整体 RPC 失败(如 server 不在)时提示一句,选择器只剩手动输入行。
          setWork({ phase: 'listingModels', since: Date.now() });
          let groups: ProviderModels[];
          try {
            groups = await session.listProviderModels();
          } catch {
            push({ kind: 'notice', level: 'warn', message: t('notice.modelsUnavailable') });
            groups = [];
          }
          endWork();
          setModelsPicker(groups);
          break;
        }
        // 只发 model:server 按实时 provider 解析(见 applyModelSwitch 的说明)。
        await applyModelSwitch(undefined, arg);
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

      // 强制重扫技能目录并列出(名字、参数提示、描述)。远程模式下这也是
      // 把 server 侧刚出现的技能立刻拉进 `/` 菜单的手动通道(平时靠 TTL)。
      case 'skills': {
        try {
          const list = await session.refreshSkills();
          push({
            kind: 'notice',
            level: 'info',
            message:
              list.length > 0
                ? t('notice.skillsList', {
                    list: list
                      .map(
                        (s) =>
                          `/${s.name}${s.argumentHint ? ` ${s.argumentHint}` : ''} — ${s.description}`,
                      )
                      .join('\n'),
                  })
                : t('notice.skillsNone'),
          });
        } catch (err) {
          push({
            kind: 'notice',
            level: 'warn',
            message: t('notice.skillsFailed', { message: (err as Error).message }),
          });
        }
        break;
      }

      // 体检读的是会话此刻的配置(含 /approvals、/models 改过的值),MCP 直接
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
            // 仅旧版 server(--attach)会抛:历史已恢复,只是没切到会话
            // 记录的 provider/model。新版恢复不再动模型。
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
        // 横幅取 session 值而非 state 镜像:resumeSession 可能刚改写了权限,
        // 镜像要到下面的 set 之后才追上。provider/model 不会被恢复改写
        //(始终沿用当前模型),但旧版 server 仍可能切,照样同步一遍。
        resetTimeline([sessionBanner(session), ...buildResumeItems(session)]);
        // 同步 UI 状态:权限可能被恢复改写;上下文用量归零,下一轮
        // step-end 会带回真实值。todos 由订阅自动更新。
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

      default: {
        // 不是内置命令:查技能表。命中则整轮交给 runSkill(激活、展开、
        // 跑轮次都在会话进程侧),display 用用户敲的原文。
        const skill = name ? session.skills.find((s) => s.name === name) : undefined;
        if (skill) {
          // 技能发起完整一轮,运行中禁止。与 `/plan <任务>` 同理走内联检查:
          // BUSY_BLOCKED_COMMANDS 是静态表,列不进动态发现的名字。
          if (busy) {
            push({ kind: 'notice', level: 'warn', message: t('notice.busyCommand', { name: name ?? '' }) });
            break;
          }
          setRunning(true);
          void session
            .runSkill(skill.name, arg, { display: raw.trim() })
            // runSkill 是 RPC:不接住的话传输层 rejection 会掀掉整个 TUI。
            .catch((err: Error) => {
              push({
                kind: 'notice',
                level: 'warn',
                message: t('notice.skillRunFailed', { message: err.message }),
              });
            })
            .finally(() => setRunning(false));
          break;
        }
        push({ kind: 'notice', level: 'warn', message: t('notice.unknownCommand', { name: name ?? '' }) });
      }
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
  // locale() 进依赖:设置面板切换语言后菜单文案立刻跟着换。
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
      // /models 不挂二级选择器:分组+搜索的交互塞不进平铺选项列表,
      // 菜单上回车直接提交无参命令,由 App 打开 ModelsPicker 覆盖层。
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
    const builtin = buildCommands().map((c) => ({ ...c, options: optionSources[c.name] }));
    // 磁盘上的技能拼在内置命令之后。同名时**内置优先**(与 Claude Code 相反):
    // 内置命令是不可替代的会话操作,不能被仓库里的一个文件顶掉。
    // description 是用户内容,原样展示,不过 t()。
    skillsTick();
    const taken = new Set(builtin.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    const skillCommands = session.skills
      .filter((s) => !taken.has(s.name))
      .map((s) => ({
        name: s.name,
        description: s.argumentHint ? `${s.description} · ${s.argumentHint}` : s.description,
      }));
    return [...builtin, ...skillCommands];
  });

  // 工作中且有任务时,状态行下方挂实时任务面板(Claude Code 的 ctrl+t 面板);
  // 空闲时清单仍走 Footer 的单行摘要,面板不重复占位。
  const todoPanelActive = () => Boolean(work()) && todos().length > 0;
  const todoPanelVisible = () => todoPanelActive() && todoPanelOpen();

  // 思考尾部窗口不再需要按终端高度打预算:活动区已并入时间线 scrollbox,
  // 矮终端上被压缩的是滚动视口,底部固定区(输入框/状态栏)天然保得住。

  /**
   * 流式正文的可见尾部。段落提交(splitCommitted)通常把可变区压得很小,
   * 但**代码围栏里没有切点**——模型写一个 500 行的文件时整块都留在
   * activeText 里,而 Markdown.tsx 每个 delta 都重建全部行的 `<Text>`
   * (定稿路径有 md-cache,这里没有),成本 O(已生成行数) → 随块长二次增长,
   * 还要让整个 scrollbox 重新布局:长代码输出到一半就能明显感到按键延迟。
   *
   * 所以给可变区一个**宽松**上限:三屏(至少 60 行)。日常段落与中等代码块
   * 远在其内,完整可见(这正是并入时间线要的效果);只有超长块会在流式期间
   * 只显示尾部,text-end 定稿后立刻全量可见。
   */
  const streamTailRows = () => Math.max(60, size.rows * 3);
  const activeStreamText = () =>
    tailWithinRows(activeText().trimEnd(), streamTailRows(), size.columns - 2 - WIDTH_SAFETY);

  // 退出 dump 的数据通道(见 Props.itemsRef)。始终存全量:dump 是留档,
  // 不跟随 /focus 的显示密度。
  createEffect(() => {
    if (props.itemsRef) props.itemsRef.current = items();
  });

  // /focus 过滤在渲染层做,items 数据全量保留——切换档位只是换谓词重画。
  const visibleItems = createMemo(() => collapseItems(items(), timelineMode()));

  /**
   * 常态的底部区域:目标行 + 输入框 + 状态栏。抽出来只为让下面那串
   * 「授权确认 / 回退选择器 / 设置面板 / 输入框」的互斥分支一眼看得清。
   *
   * 写成组件而不是裸函数,是为了白拿 createComponent 的 untrack:否则将来
   * 谁在这里加一句顶层的同步信号读取(`const busy = running(); return …`),
   * 那个信号就成了外层 Switch 的依赖,一变就整块拆了重建——打字打到一半
   * 草稿没了,而且编译期毫无提示。
   */
  const InputArea = () => (
    <Box flexDirection="column" marginTop={1}>
      {/* 目标进度贴在输入框正上方靠右:一眼能看到跑到第几轮、花了多久,
          而不必敲 /goal 去问。授权确认框、回退选择器或设置面板打开时不渲染
          (它们走的是那串互斥分支的其他支)。 */}
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
        // 点底栏的档位弹出选项框(覆盖层打开时 Footer 不在,也就没有"确认框
        // 中途改规则"的口子)。
        onModeClick={() => setModePickerOpen(true)}
        root={session.root}
        think={think()}
        segments={statusSegments()}
        columns={size.columns}
        notice={
          ctrlCArmed()
            ? t('status.ctrlcAgain')
            : escArmed()
              ? t('status.escAgainRewind')
              : modeFlash()
                ? t('status.modeCycled', { mode: modeFlash()! })
                : focusFlash()
                  ? t('status.focusCycled', { mode: focusFlash()! })
                  : expandFlash() !== undefined
                    ? t(expandFlash() ? 'status.detailsShown' : 'status.detailsHidden')
                    : copyFlash() !== undefined
                      ? t('status.selectionCopied', { n: copyFlash()! })
                      : undefined
        }
      />
    </Box>
  );

  // 界面 JSX 抽成函数,由下方 <Show keyed> 按 locale 重挂载:Solid 没有
  // "整树重渲染",切换语言后的静态文案(占位符、提示、footer 标签)只有
  // 重建 JSX 才会重新求值。信号都活在外层,重挂载不丢任何状态;代价是
  // Input 的草稿/历史清空、滚动位置回到粘底——对一个改语言的显式操作可接受。
  const body = () => (
    <Box flexDirection="column" width="100%" height="100%">
      {/* 时间线:粘底滚动,流式期间自动跟随,上滚回看自动解粘。条目定稿后
          不可变,<For> 按引用复用,Solid 细粒度更新下无重渲染开销;markdown
          按 (key, width) 缓存。 */}
      <ScrollArea>
        <For each={visibleItems()}>
          {(item) => (
            <TimelineEntry item={item} columns={size.columns} expanded={detailsExpanded()} />
          )}
        </For>

        {/* 动态区并入时间线(opencode 式):流式思考尾部/正文/进行中的工具行
            挂在 scrollbox 尾部原地生长,粘底自动跟随,上滚即可回看已生成的
            部分——正文不再裁剪,长代码块也完整可见。定稿(text-end/段落提交)
            时活动条目原位换成不可变条目,版式与前缀完全一致,肉眼无跳变。 */}
        <Show when={activeReasoning().trim()}>
          <Box marginTop={1} paddingRight={WIDTH_SAFETY}>
            <Text color={theme.dim} italic>
              {tailWithinRows(activeReasoning(), REASONING_PREVIEW_ROWS, size.columns - WIDTH_SAFETY)}
            </Text>
          </Box>
        </Show>

        <Show when={activeText().trim()}>
          <Box marginTop={1}>
            {/* 与定稿的 assistant 条目同构:首段带 ●,增量提交后的续段只缩进。 */}
            <Text color={theme.assistant}>{textCommitted() ? '  ' : `${glyphs.bullet} `}</Text>
            <Box flexDirection="column" flexGrow={1} paddingRight={WIDTH_SAFETY}>
              <Markdown text={activeStreamText()} />
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
      </ScrollArea>

      {/* 底部固定区不参与收缩:空间不足时塌缩的是上面的时间线视口,
          输入框与权限选项永远可见(矮终端保障,替代旧的 RESERVED_ROWS)。 */}
      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        {/* 工作状态行:主流 CLI 的位置——时间线之下、输入框之上。 */}
        <Show when={work()}>
          <StatusLine
            phase={work()!.phase}
            detail={work()!.detail}
            progress={work()!.progress}
            since={work()!.since}
            todoHint={todoPanelActive() ? (todoPanelOpen() ? 'hide' : 'show') : undefined}
            tokens={turnTokens()}
            columns={size.columns}
          />
        </Show>
        <Show when={todoPanelVisible()}>
          <TodoPanel todos={todos()} columns={size.columns} />
        </Show>

        {/* 屏幕底部同一时刻只归一个东西所有(overlayOpen 就是这句话的谓词):
            授权确认框 > 回退选择器 > 档位选项框 > 设置面板 > 模型/厂商选择器
            > 常态输入框,按这个优先级取第一个成立的。用 Switch 而不是层层嵌套的
            Show/fallback——后者每加一个覆盖层就多一级缩进,还得改上一个人的那支。 */}
        <Switch fallback={<InputArea />}>
          <Match when={permission()} keyed>
            {(request: PermissionRequest) => <PermissionPrompt request={request} onDecide={onDecide} />}
          </Match>
          <Match when={rewind()} keyed>
            {(entries: RewindEntry[]) => (
              <RewindPicker
                entries={entries}
                onPick={handleRewindPick}
                onCancel={() => setRewind(undefined)}
              />
            )}
          </Match>
          <Match when={modePickerOpen()}>
            <ModePicker
              options={modeOptions()}
              onPick={pickMode}
              onCancel={() => setModePickerOpen(false)}
            />
          </Match>
          <Match when={settingsOpen()}>
            <SettingsPanel
              language={locale()}
              segments={statusSegments()}
              onLanguage={applyLanguage}
              onStatusBar={applyStatusBar}
              onClose={() => setSettingsOpen(false)}
            />
          </Match>
          <Match when={modelsPicker()} keyed>
            {(groups: ProviderModels[]) => (
              <ModelsPicker
                groups={groups}
                currentProvider={session.provider.id}
                currentModel={model()}
                onPick={(providerId, modelId) => {
                  setModelsPicker(undefined);
                  void applyModelSwitch(providerId, modelId);
                }}
                onCancel={() => setModelsPicker(undefined)}
              />
            )}
          </Match>
          <Match when={providerPicker()} keyed>
            {(rows: ProviderRow[]) => (
              <ProviderPicker
                rows={rows}
                probe={probeProviderKey}
                onSwitch={(id, apiKey) => {
                  setProviderPicker(undefined);
                  void applyProviderSwitch(id, apiKey);
                }}
                onCancel={() => setProviderPicker(undefined)}
              />
            )}
          </Match>
        </Switch>
      </Box>
    </Box>
  );

  // 回调**必须**带上参数(哪怕用不到):Solid 的 Show 靠 `children.length > 0`
  // 判断这是不是「按值调用的子函数」。零元的箭头会被当成普通的响应式子节点
  // 原样返回,memo 每次拿到的是同一个函数引用 → 语言换了却什么都不重建,
  // 静态文案(占位符、菜单提示、面板标题)会一直停在旧语言上。
  return (
    <Show when={locale()} keyed>
      {(_current: Locale) => body()}
    </Show>
  );
}
