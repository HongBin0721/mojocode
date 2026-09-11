import {
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
import { Box, ScrollArea, useApp, useInput, useSelectionCopy, useTerminalSize, type JSX } from './kit.js';
import { Footer } from './Footer.js';
import { Input, type CommandOption, type SlashCommand } from './Input.js';
import { StatusLine, type WorkState } from './StatusLine.js';
import { TodoPanel } from './TodoPanel.js';
import { ExtensionStatusLine } from './ExtensionStatusLine.js';
import { TimelineEntry } from './Timeline.js';
import { collapseItems } from './focus.js';
import { createTimelineController, nextKey } from './timeline-controller.js';
import { createProviderActions } from './provider-actions.js';
import { createSubmitGate } from './commands/submit-gate.js';
import { dispatch } from './commands/index.js';
import type { CommandContext } from './commands/types.js';
import type { TimelineItem } from './types.js';
import type { SessionHandle } from '../app/session-handle.js';
import type { EditorComponentFactory } from '../core/extension-types.js';
import { SessionStore } from '../session/store.js';
import { APP_NAME } from '../config/paths.js';
import { collectRewindEntries, replayTimeline, type RewindEntry } from '../session/replay.js';
import { RewindPicker } from './RewindPicker.js';
import { UiPrompt } from './UiPrompt.js';
import { CustomHost, EditorHost, SurfaceView, type EditorRef } from './ExtensionSurface.js';
import { shortcutOf } from './extension-theme.js';
import { setMessageRenderers, setToolRenderers } from './tool-renderers.js';
import { SettingsPanel } from './SettingsPanel.js';
import { parseTodos, type TodoItem } from './timeline-data.js';
// 两个 state key 从零依赖的 wire 模块取:静态 import 扩展实现模块会把
// `ai` + `zod` 整个拉进 TUI chunk,而这里只要两个字符串。
import {
  TODO_STATE_KEY,
  type ExtensionSurface,
  type UiCustomRequest,
  type UiRequest,
} from '../core/extension-types.js';
import {
  TIMELINE_MODES,
  type ReasoningEffort,
  type StatusSegment,
  type TimelineMode,
} from '../config/schema.js';
import { BUILTIN_PROVIDER_IDS, PROVIDER_PRESETS, providerModelIsVision } from '../config/providers.js';
import { ModelsPicker } from './ModelsPicker.js';
import { ProviderPicker, type ProviderRow } from './ProviderPicker.js';
import type { ProviderModels } from '../model/registry.js';
import { saveLanguage, saveStatusBar } from '../config/save.js';
import { selectableEfforts } from './commands/config-cmds.js';
import { applyTheme, BUILTIN_THEME_NAME, listThemes, loadTheme, themeLocations, watchThemeFile } from './theme-loader.js';
import { getLocale, setLocale, t, type Locale } from '../i18n/index.js';
import { createFileLister } from '../app/file-index.js';
import { expandAtReferences, warnableSkips, type ImageAttachment } from '../app/attachments.js';
import { readClipboardImage } from '../app/clipboard.js';
import {
  buildCommands,
  FOCUS_DESCRIPTIONS,
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

/** 空清单的稳定引用:没有 todo 时也不该每次求值造一个新数组。 */
const EMPTY_TODOS: TodoItem[] = [];

export function App(props: Props): JSX.Element {
  const session = props.session;
  const { exit } = useApp();
  const size = useTerminalSize();

  const [running, setRunning] = createSignal(false);
  // ctrl+t 折叠/展开工作中的实时任务面板;偏好保持整个会话。
  //
  // 默认关闭(与 Claude Code 一致):模型每次调 todo 工具,时间线上就多一条
  // 完整清单,而面板画的正是同一份当前状态——两者逐字相同、上下紧挨着,
  // 常驻会让屏幕上重复好几份同样的任务。平时看时间线的记录即可,需要盯
  // 实时进度时再按 ctrl+t 调出来(状态行一直提示这个快捷键)。
  const [todoPanelOpen, setTodoPanelOpen] = createSignal(false);
  const [providerLabel, setProviderLabel] = createSignal(session.provider.label);
  const [model, setModel] = createSignal(session.provider.model);
  const [think, setThink] = createSignal<ReasoningEffort>(session.provider.reasoningEffort);
  const [ctrlCArmed, setCtrlCArmed] = createSignal(false);
  const [locale, setLocaleState] = createSignal(getLocale());
  const [statusSegments, setStatusSegments] = createSignal<StatusSegment[]>(session.config.statusBar);
  // /setting 设置面板(语言、状态栏)。开着时 Input 与 Footer 卸载,面板
  // 自带按键处理——与回退选择器同一套互斥渲染。
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  // esc-esc 回退:第一次 esc 预备(footer 提示),第二次打开回退选择器。
  const [escArmed, setEscArmed] = createSignal(false);
  // /focus 时间线密度;ctrl+o 会话内循环切换,/focus <mode> 落盘。
  // `?? 'full'` 防御测试里的精简版 fake session(config 缺字段)。
  const [timelineMode, setTimelineMode] = createSignal<TimelineMode>(
    session.config.timeline ?? 'full',
  );
  // /theme 提交计数:换完 +1,下方与 locale 同一个 <Show keyed> 整树重挂——
  // JSX 里读 `theme.x` 的节点会随 applyTheme 的 bump 自己变色,但扩展组件自己
  // 拼的 SGR 行、一次性算好的字符串不会,提交时重挂兜底。
  const [themeEpoch, setThemeEpoch] = createSignal(0);
  // 当前生效主题的文件(内置配色为 undefined),盯它做热重载。
  const [themeFile, setThemeFile] = createSignal<string | undefined>(undefined);
  const themeDirs = () => themeLocations(session.root, session.themeDirs ?? []);
  // 启动时按配置应用过的主题(tui.tsx)在这里补上文件路径,开始盯。查完时
  // 用户可能已经 /theme 换过了:配置里的名字变了就不覆盖。
  {
    const startupTheme = session.config.theme;
    if (startupTheme) {
      void loadTheme(startupTheme, themeDirs()).then((result) => {
        if (result.ok && session.config.theme === startupTheme && themeFile() === undefined) {
          setThemeFile(result.theme.file);
        }
      });
    }
  }
  // 热重载:主题文件改了就重读。只换色不重挂——改文件的人多半正在输入框里
  // 打字或开着选择器,每次保存都清一次草稿受不了;JSX 里读 theme.x 的节点
  // 经 bump 自己重算,扩展自拼的 SGR 行等它下次重画。坏了只提示、留着上一次
  // 的颜色;删了按"找不到"提示,同样不动颜色——别让屏幕闪回内置色。
  createEffect(
    on(themeFile, (file) => {
      if (!file) return;
      const stop = watchThemeFile(file, () => {
        const name = session.config.theme;
        if (!name) return;
        void loadTheme(name, themeDirs()).then((result) => {
          if (result.ok) {
            applyTheme(result.theme.colors);
            return;
          }
          push({
            kind: 'notice',
            level: 'warn',
            message:
              result.reason === 'not-found'
                ? t('notice.themeNotFound', { name })
                : t('notice.themeInvalid', { detail: result.detail ?? name }),
          });
        });
      });
      onCleanup(stop);
    }),
  );
  // /theme 选择器的预览:光标到哪套配色就换上,esc 收回到已提交的那套。只经
  // applyTheme 的 bump 反应式变色,不重挂(重挂会把开着的选择器关掉)。
  let previewGen = 0;
  const previewTheme = (value: string | undefined) => {
    const gen = ++previewGen;
    const name = value ?? session.config.theme ?? BUILTIN_THEME_NAME;
    if (name === BUILTIN_THEME_NAME) {
      applyTheme({});
      return;
    }
    void loadTheme(name, themeDirs()).then((result) => {
      // 光标已经移走、或这套主题坏了:不动颜色,提交时命令自己会提示。
      if (gen !== previewGen || !result.ok) return;
      applyTheme(result.theme.colors);
    });
  };
  // 命令历史活在 App:整树重挂(切语言、换主题)后上箭头还翻得到。
  const inputHistory = { current: [] as string[] };
  // ctrl+o 切换后在 footer 短暂回显新档位(得有反馈)。
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
   * 有覆盖层占着屏幕底部——回退选择器、设置面板、模型/厂商选择器取第一个
   * 成立的(见下方渲染处的 <Switch>)。它们渲染期间 Input 与 Footer 都已
   * 卸载,所以任何「靠 footer 回显反馈」的全局快捷键都要拿它挡一下。
   */
  const overlayOpen = () =>
    uiCustom() !== undefined ||
    uiPrompt() !== undefined ||
    rewind() !== undefined ||
    settingsOpen() ||
    modelsPicker() !== undefined ||
    providerPicker() !== undefined;

  /**
   * 事件状态机:AgentEvent → 时间线/流式/状态行/用量(实现见
   * timeline-controller.ts)。App 只拿回 getter/setter;模型名归 App 的信号,
   * 经回调上抛。必须在 setup 作用域内同步创建(订阅的 onCleanup 绑定当时的
   * owner)。
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
  } = createTimelineController(session, { getModel: model });

  // 装配期的提示(见 SessionHandle.startupNotices):进程内模式下 bootstrap
  // emit 的时刻没有任何订阅者,只能在这里取。远程模式该字段为空,提示经
  // SSE 走 bus,不会重复。
  for (const notice of session.startupNotices ?? []) {
    push({ kind: 'notice', level: notice.level, message: notice.message });
  }

  let ctrlCTimer: NodeJS.Timeout | undefined;
  let escTimer: NodeJS.Timeout | undefined;
  // 提交门:submitPending / cannedLaunchPending / submitGen 三件套收编成
  // 一个对象——handleSubmit / handleEscape / 命令 dispatch 三方共用的
  // 可变状态,语义注释随实现住在 ./commands/submit-gate.ts。
  const submitGate = createSubmitGate();

  // 技能列表变化(新增/删除 SKILL.md、/skills 强制重扫)时 bump 信号,
  // 驱动 commands memo 重算,`/` 菜单跟着刷新。
  const [skillsTick, setSkillsTick] = createSignal(0);
  {
    const off = session.skillsChanged(() => setSkillsTick((n) => n + 1));
    onCleanup(off);
  }
  // 扩展的命令表/状态行同款:变化时 bump 信号,菜单与输入框上方的状态行重算。
  const [extensionsTick, setExtensionsTick] = createSignal(0);
  {
    const off = session.extensionsChanged(() => setExtensionsTick((n) => n + 1));
    onCleanup(off);
  }
  const extensionStatus = createMemo(() => {
    extensionsTick();
    return session.extensionStatus;
  });
  /**
   * 扩展向用户提的问题(ctx.ui.*):队列里还挂着的第一条就是当前提示框。
   * `answerUi` 同步把它从队列里摘掉并通知,所以这里不需要"答过的 id"去重——
   * 那是远程时代(下一帧快照要几拍才到)的补丁,单进程之后是纯负担。
   */
  const uiPrompt = createMemo((): UiRequest | undefined => {
    extensionsTick();
    return session.uiRequests[0];
  });
  /**
   * 扩展的渲染层(Pi 的 ctx.ui.custom / setWidget / setHeader / setFooter /
   * setTitle,以及工具的 renderCall / renderResult)。挂载即告诉会话「有人在看」
   * ——扩展的提问从此真的等人答;卸载后回到缺省兑现。
   */
  // 草稿是**拉取式**的:Input 挂载时把自己的取值函数放进来。推送式(每次
  // 按键回调一次)要为一个几乎没人读的镜像在最热的输入路径上多跑一个
  // 响应式节点。
  const editor: EditorRef = {};
  session.attachUi({
    available: () => true,
    getEditorText: () => editor.read?.() ?? '',
    // 缺省输入框走 prefill(它自己在下一帧消费);扩展编辑器挂着时直接写它。
    setEditorText: (text) => (editor.write ? editor.write(text) : setPrefill({ text })),
    pasteToEditor: (text) => editor.insert?.(text),
  });
  onCleanup(() => session.attachUi(undefined));
  const uiCustom = createMemo((): UiCustomRequest | undefined => {
    extensionsTick();
    return session.uiCustoms[0];
  });
  const uiSurfaces = createMemo(() => {
    extensionsTick();
    return session.uiSurfaces;
  });
  createEffect(() => {
    extensionsTick();
    setToolRenderers(session.toolRenderers);
    setMessageRenderers(session.messageRenderers);
  });
  /**
   * 终端窗口标题:OSC 0。**自己一个 memo**:effect 直接读 uiSurfaces() 的话,
   * 任何一块 widget 变化都会重写一遍标题(todo 每跳一次就是一次终端写入),
   * 而 memo 按字符串比较,标题没变就不唤醒 effect。只在真终端上写,且只在
   * 扩展设过标题之后才动它——测试的 stdout 不是 TTY。
   */
  const uiTitle = createMemo(() => uiSurfaces().title);
  let titleTouched = false;
  createEffect(() => {
    const title = uiTitle();
    if (title === undefined && !titleTouched) return;
    titleTouched = true;
    if (process.stdout.isTTY) process.stdout.write(`\x1b]0;${title ?? APP_NAME}\x07`);
  });
  /**
   * todo 清单由 todo 扩展经 setState 发布(核心不再有 TodoStore):形状不对
   * 一律当没有——扩展没装、或换了别的实现时,面板与底栏摘要各自消失即可。
   *
   * **memo 而非普通箭头**:parseTodos 是个 filter,每次求值都返回新数组,而
   * 这个访问器一次渲染要被读五遍(todoPanelActive / todoPanelVisible /
   * todoHint / Footer / TodoPanel),新引用还会让 TodoPanel 里按 props.todos
   * 建的 memo 每遍都重算。它原来是 `session.todos.subscribe` 喂的 signal,
   * 引用天然稳定;搬成扩展状态之后这份稳定性得自己补回来。
   */
  const todos = createMemo((): TodoItem[] => {
    extensionsTick();
    return parseTodos(session.extensionState[TODO_STATE_KEY]) ?? EMPTY_TODOS;
  });

  // ctrl+c 无论何时都要能退出(包括覆盖层打开时),所以单独一个始终激活的
  // 处理器。依赖 kit render() 默认的 exitOnCtrlC: false——否则渲染器会在
  // useInput 之前吞掉这个按键,这里永远收不到。
  useInput((input, key) => {
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
      return;
    }
    // 扩展的快捷键(registerShortcut)排在**全部内置分支之后**:注册那头已经
    // 按 RESERVED_SHORTCUTS 拒过 ctrl+c/t/o/r,这里的顺序是第二道防线——
    // 一个绕过注册闸门的键也绝不能把「双 ctrl+c 退出」吃掉。覆盖层打开时
    // 不派发:那时键盘归覆盖层。
    if ((key.ctrl || key.meta) && !overlayOpen()) session.runShortcut(shortcutOf(input, key));
  });

  // 全部定时器都要清:cli.tsx 只设 process.exitCode 而不调 process.exit(),
  // 任何挂着的定时器都会让事件循环多活到它触发为止——按过 shift+tab 之后
  // 两秒内连按 ctrl+c 退出,进程会僵在那里等这个回显定时器。
  onCleanup(() => {
    if (ctrlCTimer) clearTimeout(ctrlCTimer);
    if (escTimer) clearTimeout(escTimer);
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

  // 重建时间线时的横幅:与 sessionBanner 的区别是读 state 镜像,/models
  // 等会话中途的改动会反映进去。
  const bannerItem = (): TimelineItem => ({
    key: nextKey(),
    kind: 'banner',
    providerLabel: providerLabel(),
    model: model(),
    root: session.root,
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
      if (submitGate.cannedPending && !session.agent.isRunning) return;
      submitGate.invalidate();
      if (!session.agent.isRunning) {
        setRunning(false);
        return;
      }
    }
    if (session.agent.isRunning) {
      // 链条(首轮 + 扩展排的续跑)期间 isRunning 一直为真,两轮之间也是:
      // abort 落在轮内就掐当前流,落在两轮之间就丢掉排好的续跑(见 loop.ts)。
      session.agent.abort();
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

  /** 运行中拦截谓词:isRunning、isCompacting、提交在途任一成立。 */
  const busy = () => session.agent.isRunning || session.agent.isCompacting || submitGate.pending;

  const cmdCtx: CommandContext = {
    session,
    exit,
    push,
    setItems,
    setUsage,
    setWork,
    endWork,
    usage,
    think,
    timelineMode,
    setThink,
    setTimelineMode,
    refreshTheme: (file) => {
      previewGen++;
      setThemeFile(file);
      setThemeEpoch((n) => n + 1);
    },
    setProviderLabel,
    setModel,
    setRunning,
    setSettingsOpen,
    setModelsPicker,
    setProviderPicker,
    setPrefill,
    busy,
    bannerItem,
    providerActions,
    submitGate,
  };

  const runCommand = (raw: string) => dispatch(cmdCtx, raw);

  // @ 文件补全的数据源:懒扫描 + TTL 缓存,注入给 Input。
  const fileLister = createFileLister(session.root);

  const handleSubmit = (text: string, pastedImages?: ImageAttachment[]) => {
    if (text.startsWith('/')) {
      void runCommand(text);
      return;
    }
    // `!command`(Pi 同款):在工作区跑一条 shell 命令,输出并入历史不开轮;
    // 时间线由 custom-message 事件画。`!` 后面空着不算命令。
    if (text.startsWith('!') && text.slice(1).trim()) {
      void session.runUserBash(text.slice(1)).catch((err: Error) => {
        push({ kind: 'notice', level: 'warn', message: err.message });
      });
      return;
    }
    // 罐装命令的阶段一窗口(/simplify 四个子代理并行,主 agent 空闲,可达数
    // 分钟):普通消息没有在途的轮可注入,放过去会经 goal.run 另起一轮,
    // 阶段二的应用轮提示词随后撞上防重入兜底、整份灌进用户那轮;且这条
    // 路径会清掉 submitPending 把 busy 门重新打开。窗口期内拒绝——轮子转
    // 起来(turn-start 之后)inject 恢复正常,引导照常可用。
    if (submitGate.cannedPending && !session.agent.isRunning) {
      push({ kind: 'notice', level: 'warn', message: t('notice.cannedBusy') });
      return;
    }
    // 以 agent 的真实运行状态为准,不依赖可能滞后的渲染状态。展开
    // @ 引用是异步的,空闲时先亮起运行态保住提交的即时反馈。
    if (!session.agent.isRunning) setRunning(true);
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
        if (!session.agent.isRunning) setRunning(false);
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
      setRunning(true);
      // run 覆盖整个链条(首轮 + 扩展经 followUp 排的续跑,如 /goal 的评估
      // 后续跑),setRunning(false) 因此只在链条结束时才触发,状态行在自动
      // 续跑期间保持常亮。
      await session.agent
        .run(expanded, Object.keys(runOptions).length > 0 ? runOptions : undefined)
        .finally(() => setRunning(false));
    })().catch((err: Error) => {
      // agent.run 自身不 reject,但前面 await 的 inject 会;这里是个 void 的
      // 异步 IIFE——未捕获的 rejection 在 Node ≥20 / Bun 下直接掀掉整个 TUI。
      // 与 /init、/goal 同一条教训。
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
      // 档位来源见 selectableEfforts(与 /think 参数校验同一处)。
      think: async () =>
        (await selectableEfforts(session)).map((l) => ({
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
      // 磁盘上的主题现扫(改了文件不必重启);`default` 是内置配色的保留名。
      theme: async () => {
        const current = session.config.theme ?? BUILTIN_THEME_NAME;
        const found = await listThemes(themeDirs());
        return [
          { value: BUILTIN_THEME_NAME, label: t('themeopt.default'), current: current === BUILTIN_THEME_NAME },
          ...found.map((entry) => ({ value: entry.name, label: entry.file, current: entry.name === current })),
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
          // 归档会话不进恢复选择器(GUI 的归档视图才列它们)。
          .filter((m) => !m.archivedAt)
          .filter((m) => m.id !== session.store.id)
          .map((m) => ({
            value: m.id.slice(0, 8),
            label:
              `${m.updatedAt.slice(0, 16).replace('T', ' ')} · ` +
              `${t('cli.msgs', { n: m.messageCount })}${m.title ? ` · ${m.title}` : ''}`,
          }));
      },
    };
    const builtin = buildCommands().map((c) => ({
      ...c,
      options: optionSources[c.name],
      ...(c.name === 'theme' ? { onHighlight: previewTheme } : {}),
    }));
    // 磁盘上的技能拼在内置命令之后。同名时**内置优先**(与 Claude Code 相反):
    // 内置命令是不可替代的会话操作,不能被仓库里的一个文件顶掉。
    // description 是用户内容,原样展示,不过 t()。
    skillsTick();
    extensionsTick();
    const taken = new Set(builtin.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    // 扩展注册的命令排在内置之后、技能之前:它们是代码,比磁盘上的一个
    // SKILL.md 更接近内置;同名规则与技能一致——内置优先。
    const extensionCommands = session.extensionCommands
      .filter((c) => !taken.has(c.name))
      .map((c) => {
        taken.add(c.name);
        return {
          name: c.name,
          description: c.argumentHint ? `${c.description} · ${c.argumentHint}` : c.description,
          ...(c.selectorTitle ? { selectorTitle: c.selectorTitle } : {}),
          // 取值每次现取(档位要标当前生效的那一档,分支列表要跑 git),
          // 所以是一次调用而不是静态表。
          ...(c.hasOptions ? { options: (path: string[]) => session.commandOptions(c.name, path) } : {}),
        };
      });
    const skillCommands = session.skills
      .filter((s) => !taken.has(s.name))
      .map((s) => ({
        name: s.name,
        description: s.argumentHint ? `${s.description} · ${s.argumentHint}` : s.description,
      }));
    return [...builtin, ...extensionCommands, ...skillCommands];
  });

  // 工作中且有任务时,状态行下方挂实时任务面板(Claude Code 的 ctrl+t 面板);
  // 空闲时清单仍走 Footer 的单行摘要,面板不重复占位。
  const todoPanelActive = () => Boolean(work()) && todos().length > 0;
  const todoPanelVisible = () => todoPanelActive() && todoPanelOpen();
  const todoHint = () => (todoPanelActive() ? (todoPanelOpen() ? 'hide' : 'show') : undefined);

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
  /**
   * 工作状态线。**一处定义两处用**:输入框自己画的那条是框的顶边(归
   * Input),而"输入框被顶掉了"的两种情形——扩展编辑器、各类覆盖层——都要
   * 把它单独画在上方,否则一开框 spinner 与已用时就没了。曾经是两份逐字
   * 相同的 JSX,`label`(扩展的 setWorkingMessage)加进来时要在两处各写一笔。
   */
  const WorkStatus = (p: { when?: boolean }) => (
    // 不加 keyed:work 每次阶段变化都是新对象,keyed 会整块重建,
    // spinner 的定时器跟着重启、已用时清零。
    <Show when={(p.when ?? true) ? work() : undefined}>
      {(current: () => WorkState) => (
        <StatusLine
          work={current()}
          todoHint={todoHint()}
          tokens={turnTokens()}
          columns={size.columns}
          label={uiSurfaces().workingMessage}
        />
      )}
    </Show>
  );

  /** 缺省输入框。单独成组件只为让下面那句 Show 的 fallback 是一行。 */
  const DefaultInput = () => (
    <Input
      onSubmit={handleSubmit}
      disabled={false}
      work={work()}
      todoHint={todoHint()}
      turnTokens={turnTokens()}
      placeholder={running() || work() ? t('input.steer') : t('input.placeholder')}
      busy={running() || Boolean(work())}
      commands={commands()}
      onEscape={handleEscape}
      prefill={prefill()}
      onPrefillConsumed={clearPrefill}
      editorRef={editor}
      historyRef={inputHistory}
      fileIndex={fileLister}
      readClipboardImage={readClipboardImage}
      onImageNotice={(message) => push({ kind: 'notice', level: 'warn', message })}
      workingMessage={uiSurfaces().workingMessage}
    />
  );

  const InputArea = () => (
    // 不设 marginTop:与时间线的分隔由外层底部固定区统一给出(一行)。这里
    // 再叠一层的话,状态行/待办面板都不在的常态会空出两行——正是时间线与
    // 输入框之间那道多出来的缝。与上方块的间距归上方块自己的 marginBottom。
    <Box flexDirection="column">
      {/* 扩展的状态行贴在输入框正上方靠右(如 /goal 的「目标 3/10 · 1m04s」):
          一眼能看到进度而不必敲命令去问。回退选择器或设置面板打开时不渲染
          (它们走的是那串互斥分支的其他支)。 */}
      <For each={uiSurfaces().widgets}>{(widget) => <SurfaceView surface={widget.surface} />}</For>
      <ExtensionStatusLine entries={extensionStatus} columns={size.columns} />
      {/* 扩展的 setEditorComponent 顶替缺省输入框(Pi 同款):它换掉的只是输入框,
          widget、状态行、底栏照旧——那是"编辑器"与"覆盖层"的区别,所以它留在
          这里而不是下面那串互斥分支里。工作状态线跟着挪到它上方。 */}
      <Show when={uiSurfaces().editor} keyed fallback={<DefaultInput />}>
        {(factory: EditorComponentFactory) => (
          <>
            <WorkStatus />
            <EditorHost
              factory={factory}
              onSubmit={handleSubmit}
              // 跑着的时候 esc 归中断,不转发给组件(见 EditorHost 的注释)。
              onEscape={() => {
                if (!session.agent.isRunning && !submitGate.pending) return false;
                handleEscape();
                return true;
              }}
              editorRef={editor}
            />
          </>
        )}
      </Show>
      {/* 扩展的 setFooter 整个替换底栏(Pi 同款:换了就由扩展负责画全)。 */}
      <Show
        when={uiSurfaces().footer}
        fallback={
          <Footer
            contextUsed={usage().used}
            contextWindow={usage().window}
            cumulativeTokens={usage().total}
            // 实时面板已在上方展开时,底栏不再重复一行摘要。
            todos={todoPanelVisible() ? [] : todos()}
            model={model()}
            root={session.root}
            think={think()}
            segments={statusSegments()}
            columns={size.columns}
            notice={
              ctrlCArmed()
                ? t('status.ctrlcAgain')
                : escArmed()
                  ? t('status.escAgainRewind')
                  : focusFlash()
                    ? t('status.focusCycled', { mode: focusFlash()! })
                    : expandFlash() !== undefined
                      ? t(expandFlash() ? 'status.detailsShown' : 'status.detailsHidden')
                      : copyFlash() !== undefined
                        ? t('status.selectionCopied', { n: copyFlash()! })
                        : undefined
            }
          />
        }
      >
        {(footer: () => ExtensionSurface) => <SurfaceView surface={footer()} />}
      </Show>
    </Box>
  );

  // 界面 JSX 抽成函数,由下方 <Show keyed> 按 locale 与 themeEpoch 重挂载:
  // Solid 没有"整树重渲染",切换语言后的静态文案(占位符、提示、footer 标签)
  // 与换主题后已画出的颜色只有重建 JSX 才会重新求值。信号都活在外层,
  // 重挂载不丢任何状态(命令历史也在外层的 inputHistory 里);代价是 Input
  // 的草稿清空、滚动位置回到粘底——对改语言 / 换主题这样的显式操作可接受。
  const body = () => (
    <Box flexDirection="column" width="100%" height="100%">
      {/* 扩展的 setHeader:屏幕顶部、时间线之上的一块。 */}
      <Show when={uiSurfaces().header}>
        {(header: () => ExtensionSurface) => <SurfaceView surface={header()} />}
      </Show>
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
        <Show when={todoPanelVisible()}>
          <TodoPanel todos={todos()} columns={size.columns} />
        </Show>
        {/* 覆盖层顶掉输入框时,状态线留在覆盖层上方(见 WorkStatus)。 */}
        <WorkStatus when={overlayOpen()} />

        {/* 屏幕底部同一时刻只归一个东西所有(overlayOpen 就是这句话的谓词):
            扩展组件 > 扩展提问 > 回退选择器 > 设置面板 > 模型/厂商选择器 > 常态输入框,按这个优先级
            取第一个成立的。用 Switch 而不是层层嵌套的 Show/fallback——后者每
            加一个覆盖层就多一级缩进,还得改上一个人的那支。 */}
        <Switch fallback={<InputArea />}>
          <Match when={uiCustom()} keyed>
            {(request: UiCustomRequest) => (
              <CustomHost
                request={request}
                onDone={(value) => session.resolveCustom(request.id, value)}
              />
            )}
          </Match>
          <Match when={uiPrompt()} keyed>
            {(request: UiRequest) => (
              <UiPrompt
                request={request}
                onAnswer={(answer) => session.answerUi(request.id, answer)}
              />
            )}
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
        </Switch>
      </Box>
    </Box>
  );

  // 回调**必须**带上参数(哪怕用不到):Solid 的 Show 靠 `children.length > 0`
  // 判断这是不是「按值调用的子函数」。零元的箭头会被当成普通的响应式子节点
  // 原样返回,memo 每次拿到的是同一个函数引用 → 语言换了却什么都不重建,
  // 静态文案(占位符、菜单提示、面板标题)会一直停在旧语言上。
  return (
    <Show when={`${locale()}:${themeEpoch()}`} keyed>
      {(_current: string) => body()}
    </Show>
  );
}
