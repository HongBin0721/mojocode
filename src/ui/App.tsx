import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from 'solid-js';
import { Box, ScrollArea, Text, useApp, useInput, useSelectionCopy, useTerminalSize, type JSX } from './kit.js';
import { Footer } from './Footer.js';
import { Input, type CommandOption, type SlashCommand } from './Input.js';
import { StatusLine } from './StatusLine.js';
import { TodoPanel } from './TodoPanel.js';
import { GoalLine } from './GoalLine.js';
import { TimelineEntry } from './Timeline.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { collapseItems } from './focus.js';
import {
  buildResumeItems,
  createTimelineController,
  nextKey,
  sessionBanner,
} from './timeline-controller.js';
import { createProviderActions } from './provider-actions.js';
import { createSubmitGate } from './commands/submit-gate.js';
import { dispatch } from './commands/index.js';
import { launchReview } from './commands/review-cmds.js';
import type { CommandContext } from './commands/types.js';
import type { TimelineItem } from './types.js';
import type {
  PermissionDecision,
  PermissionRequest,
} from '../core/events.js';
import type { SessionHandle } from '../app/session-handle.js';
import { SessionStore } from '../session/store.js';
import { collectRewindEntries, replayTimeline, type RewindEntry } from '../session/replay.js';
import { RewindPicker } from './RewindPicker.js';
import { ReviewPicker, type ReviewPickerRow } from './ReviewPicker.js';
import { SettingsPanel } from './SettingsPanel.js';
import { ModePicker, type ModeOption } from './ModePicker.js';
import type { TodoItem } from '../tools/index.js';
import {
  APPROVAL_PRESETS,
  isDangerousPermissions,
  nextCycleStep,
  permissionsLabel,
  presetById,
  TIMELINE_MODES,
  type ApprovalPresetId,
  type Permissions,
  type ReasoningEffort,
  type StatusSegment,
  type TimelineMode,
} from '../config/schema.js';
import { BUILTIN_PROVIDER_IDS, PROVIDER_PRESETS, providerModelIsVision } from '../config/providers.js';
import { ModelsPicker } from './ModelsPicker.js';
import { ProviderPicker, type ProviderRow } from './ProviderPicker.js';
import type { ProviderModels } from '../model/registry.js';
import {
  saveLanguage,
  savePermissions,
  saveStatusBar,
} from '../config/save.js';
import { supportedEfforts } from '../model/reasoning.js';
import { getLocale, setLocale, t, type Locale } from '../i18n/index.js';
import { createFileLister } from '../app/file-index.js';
import { expandAtReferences, warnableSkips, type ImageAttachment } from '../app/attachments.js';
import { readClipboardImage } from '../app/clipboard.js';
import {
  buildCommands,
  FOCUS_DESCRIPTIONS,
  PRESET_DESCRIPTIONS,
  THINK_DESCRIPTIONS,
} from './commands/registry.js';
import { ActiveStream } from './ActiveStream.js';

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

  const [permission, setPermission] = createSignal<PermissionRequest | undefined>(undefined);
  const [running, setRunning] = createSignal(false);
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
  // /review 选完预设后的第二级选择器(基准分支 / 提交),同上面的互斥渲染。
  const [reviewPicker, setReviewPicker] = createSignal<
    { kind: 'base' | 'commit'; title: string; rows: ReviewPickerRow[] } | undefined
  >(undefined);
  // 回退后预填输入框的内容;Input 写入后回调清空,避免它重挂载时二次覆盖
  // 用户的新草稿。
  const [prefill, setPrefill] = createSignal<{ text: string } | undefined>(undefined);
  const clearPrefill = () => setPrefill(undefined);
  // /review 第二级选择器 esc 返回预设层:请求 Input 重开 review 的二级
  // 选择器。与 prefill 同一消费语义(新对象 + 回调清空)。
  const [selectorRequest, setSelectorRequest] = createSignal<
    { command: string; index?: number } | undefined
  >(undefined);
  const clearSelectorRequest = () => setSelectorRequest(undefined);

  /**
   * 有覆盖层占着屏幕底部——授权确认框、回退选择器、档位选项框、设置面板、
   * 模型/厂商选择器、/review 的分支/提交选择器取第一个成立的(见下方渲染处
   * 的 <Switch>)。它们渲染期间 Input 与 Footer 都已卸载,所以任何「靠 footer
   * 回显反馈」的全局快捷键都要拿它挡一下。
   */
  const overlayOpen = () =>
    permission() !== undefined ||
    rewind() !== undefined ||
    settingsOpen() ||
    modePickerOpen() ||
    modelsPicker() !== undefined ||
    providerPicker() !== undefined ||
    reviewPicker() !== undefined;

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
    setReviewPicker(undefined);
    setPermission(request);
  };

  // 待处理的权限 resolver。Solid 下就是普通变量:处理器读的永远是当前值。
  let resolvePermission: ((decision: PermissionDecision) => void) | undefined;

  /**
   * 事件状态机:AgentEvent → 时间线/流式/状态行/用量(实现见
   * timeline-controller.ts)。App 只拿回 getter/setter;权限弹窗、权限镜像、
   * 模型名、目标行这四样归 App 的信号,经回调上抛。必须在 setup 作用域内
   * 同步创建(订阅的 onCleanup 绑定当时的 owner)。
   */
  const {
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
  } = createTimelineController(session, {
    onPermissionRequest: showPermission,
    // 命令侧的手动同步是同值 setState,与事件路径并存不碍事。
    onPermissionChange: (permissions, plan) => {
      setPerms(permissions);
      setPlanActive(plan);
    },
    getModel: model,
    onGoalActiveChange: setGoalActive,
  });

  let ctrlCTimer: NodeJS.Timeout | undefined;
  let escTimer: NodeJS.Timeout | undefined;
  // 提交门:submitPending / cannedLaunchPending / submitGen 三件套收编成
  // 一个对象——handleSubmit / handleEscape / 命令 dispatch 三方共用的
  // 可变状态,语义注释随实现住在 ./commands/submit-gate.ts。
  const submitGate = createSubmitGate();

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
    if (submitGate.pending) {
      // 例外:pending 属于罐装命令(/review、/simplify)启动的 git 收集
      // 窗口——没有可作废的提交,清掉标志只会重新打开 busy 门(见
      // submit-gate 的注释)。窗口次秒级,忽略这次 esc;轮子转
      // 起来后走下面的正常中断。
      if (submitGate.cannedPending && !session.agent.isRunning && !session.goal.busy) return;
      submitGate.invalidate();
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
    // 上下文用量换成截断后历史的估算(setHistory 后 lastInputTokens 已
    // 作废)。累计消耗保留——那些 token 确实花掉了。
    setUsage((prev) => ({ ...prev, used: session.agent.contextUsage.used }));
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
   * provider/model 切换的统一落地(实现见 provider-actions.ts):/provider、
   * /models 两条命令与两个选择器共用的出口,镜像 setter 由这里注入。
   */
  const providerActions = createProviderActions({ session, push, setProviderLabel, setModel, setThink, setUsage });

  // ---- 斜杠命令:dispatch 入口与依赖上下文(实现见 ./commands/) ----

  /** 运行中拦截谓词:isRunning、isCompacting、提交在途、goal.busy 任一成立。 */
  const busy = () =>
    session.agent.isRunning ||
    session.agent.isCompacting ||
    submitGate.pending ||
    session.goal.busy;

  const cmdCtx: CommandContext = {
    session,
    exit,
    push,
    setItems,
    setUsage,
    setWork,
    endWork,
    usage,
    perms,
    planActive,
    modeLabel,
    think,
    timelineMode,
    setPerms,
    setPlanActive,
    setThink,
    setTimelineMode,
    setProviderLabel,
    setModel,
    setRunning,
    setSettingsOpen,
    setModelsPicker,
    setProviderPicker,
    setReviewPicker,
    setPrefill,
    busy,
    bannerItem,
    persistPermissions,
    providerActions,
    submitGate,
  };

  const runCommand = (raw: string) => dispatch(cmdCtx, raw);

  // @ 文件补全的数据源:懒扫描 + TTL 缓存,注入给 Input。
  const fileLister = createFileLister(session.root);

  // 稳定引用:GoalLine 靠自己的秒表驱动,每次现读快照。
  const goalSnapshot = () => session.goal.snapshot();

  const handleSubmit = (text: string, pastedImages?: ImageAttachment[]) => {
    if (text.startsWith('/')) {
      void runCommand(text);
      return;
    }
    // 罐装命令的阶段一窗口(/simplify 四个子代理并行,主 agent 空闲,可达数
    // 分钟):普通消息没有在途的轮可注入,放过去会经 goal.run 另起一轮,
    // 阶段二的应用轮提示词随后撞上防重入兜底、整份灌进用户那轮;且这条
    // 路径会清掉 submitPending 把 busy 门重新打开。窗口期内拒绝——轮子转
    // 起来(turn-start 之后)inject 恢复正常,引导照常可用。
    if (submitGate.cannedPending && !session.agent.isRunning && !session.goal.busy) {
      push({ kind: 'notice', level: 'warn', message: t('notice.cannedBusy') });
      return;
    }
    // 以 agent 的真实运行状态为准,不依赖可能滞后的渲染状态。展开
    // @ 引用是异步的,空闲时先亮起运行态保住提交的即时反馈。
    if (!session.agent.isRunning && !session.goal.busy) setRunning(true);
    // 回车之后、run() 之前有一段 agent 仍是 idle 的窗口。不标记的话,
    // 这期间 esc 会去武装回退选择器而不是取消,/clear 之类命令也会绕过
    // busy 拦截把历史换掉,随后排队的这一轮再往新会话里写。
    const gen = submitGate.begin();
    void (async () => {
      let expanded = text;
      const images: ImageAttachment[] = [...(pastedImages ?? [])];
      try {
        const result = await expandAtReferences(text, {
          root: session.root,
          denyPath: session.config.permissions.denyPath,
          // 非视觉模型直接以引用模式展开 @图:省掉纯 JS 降采样(大截图要
          // 几百毫秒 CPU)。判定与 Agent.prepareUserMessage 共用
          // providerModelIsVision;粘贴图没有引用模式,降级发生在 Agent 侧
          // (落盘 + 信封)。
          imageMode: providerModelIsVision(session.provider, session.config)
            ? 'inline'
            : 'reference',
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
      if (submitGate.gen !== gen) {
        if (!session.agent.isRunning && !session.goal.busy) setRunning(false);
        return;
      }
      submitGate.clearPending();
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
      submitGate.clearPending();
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
      // /review 的预设选择器(Codex 式两行渲染):四个固定预设,顺序与 Codex
      // 一致。base/commit 提交后在命令分支里再开第二级选择器选分支/提交;
      // custom 提交后预填输入框。git 在 server 侧跑——--attach 时仓库不在 UI
      // 这台机器上;非仓库返回空表,Input 的选择器对空表回退成裸提交,由命令
      // 分支给出 no-repo 提示。
      review: async (): Promise<CommandOption[]> => {
        const targets = await session.reviewTargets().catch(() => undefined);
        if (!targets?.isRepo) return [];
        return [
          { value: 'base', title: t('reviewopt.baseTitle'), label: t('reviewopt.baseDesc') },
          {
            value: 'uncommitted',
            title: t('reviewopt.uncommittedTitle'),
            label: t('reviewopt.uncommittedDesc'),
          },
          { value: 'commit', title: t('reviewopt.commitTitle'), label: t('reviewopt.commitDesc') },
          { value: 'custom', title: t('reviewopt.customTitle'), label: t('reviewopt.customDesc') },
        ];
      },
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

  // 流式正文尾部窗口(streamTailRows/activeStreamText)随动态区一起
  // 搬进了 ActiveStream.tsx——终端尺寸经它的 props 传入。

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
    // 不设 marginTop:与时间线的分隔由外层底部固定区统一给出(一行)。这里
    // 再叠一层的话,状态行/待办面板都不在的常态会空出两行——正是时间线与
    // 输入框之间那道多出来的缝。与上方块的间距归上方块自己的 marginBottom。
    <Box flexDirection="column">
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
        requestSelector={selectorRequest()}
        onSelectorConsumed={clearSelectorRequest}
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

        {/* 动态区并入时间线(opencode 式),实现见 ActiveStream.tsx:
            流式思考尾部/正文/进行中的工具行挂在 scrollbox 尾部原地生长。 */}
        <ActiveStream
          activeReasoning={activeReasoning}
          activeText={activeText}
          textCommitted={textCommitted}
          activeTools={activeTools}
          taskProgress={taskProgress}
          columns={() => size.columns}
          rows={() => size.rows}
        />
      </ScrollArea>

      {/* 底部固定区不参与收缩:空间不足时塌缩的是上面的时间线视口,
          输入框与权限选项永远可见(矮终端保障,替代旧的 RESERVED_ROWS)。
          这里的 marginTop 是时间线与下方内容(状态行/待办面板/输入框/各
          覆盖层)之间**唯一**的分隔——子块一律不再自带顶部 margin,否则
          缝叠成两行(时间线与输入框之间那道多出来的空行就是这么来的)。 */}
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
            > /review 的分支/提交选择器 > 常态输入框,按这个优先级取第一个成立
            的。用 Switch 而不是层层嵌套的 Show/fallback——后者每加一个覆盖层
            就多一级缩进,还得改上一个人的那支。 */}
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
                  void providerActions.applyModelSwitch(providerId, modelId);
                }}
                onCancel={() => setModelsPicker(undefined)}
              />
            )}
          </Match>
          <Match when={providerPicker()} keyed>
            {(rows: ProviderRow[]) => (
              <ProviderPicker
                rows={rows}
                probe={providerActions.probeProviderKey}
                onSwitch={(id, apiKey) => {
                  setProviderPicker(undefined);
                  void providerActions.applyProviderSwitch(id, apiKey);
                }}
                onCancel={() => setProviderPicker(undefined)}
              />
            )}
          </Match>
          <Match when={reviewPicker()} keyed>
            {(picker: { kind: 'base' | 'commit'; title: string; rows: ReviewPickerRow[] }) => (
              <ReviewPicker
                title={picker.title}
                rows={picker.rows}
                onPick={(value) => {
                  setReviewPicker(undefined);
                  launchReview(cmdCtx, `${picker.kind} ${value}`);
                }}
                onCancel={() => {
                  // esc 退回上一级:重开预设选择器,光标还原到刚才那个预设
                  // (base=0 / commit=2)。Input 随本浮层关闭而重挂,请求在
                  // 挂载效应里消费。
                  setReviewPicker(undefined);
                  setSelectorRequest({
                    command: 'review',
                    index: picker.kind === 'base' ? 0 : 2,
                  });
                }}
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
