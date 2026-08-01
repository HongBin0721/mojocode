import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { Header } from './Header.js';
import { Footer } from './Footer.js';
import { Input, type CommandOption, type SlashCommand } from './Input.js';
import { StatusLine, type WorkPhase, type WorkState } from './StatusLine.js';
import { TimelineEntry } from './Timeline.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { theme, glyphs, formatToolInput } from './theme.js';
import { Markdown } from './Markdown.js';
import { splitCommitted, tailWithinRows } from './preview.js';
import type { ActiveToolCall, NewTimelineItem, TimelineItem } from './types.js';
import type { AgentEvent, PermissionDecision, PermissionRequest } from '../core/events.js';
import { ProviderSwitchError, type Session } from '../app/bootstrap.js';
import { SessionStore } from '../session/store.js';
import { collectRewindEntries, replayTimeline, type RewindEntry } from '../session/replay.js';
import { RewindPicker } from './RewindPicker.js';
import type { TodoItem } from '../tools/index.js';
import {
  STATUS_SEGMENTS,
  permissionModeSchema,
  reasoningEffortSchema,
  type PermissionMode,
  type ReasoningEffort,
  type StatusSegment,
} from '../config/schema.js';
import { BUILTIN_PROVIDER_IDS, PROVIDER_PRESETS } from '../config/providers.js';
import {
  saveLanguage,
  saveMode,
  saveModelChoice,
  saveProviderChoice,
  saveReasoningEffort,
  saveStatusBar,
} from '../config/save.js';
import { listModels } from '../model/registry.js';
import { supportedEfforts } from '../model/reasoning.js';
import { LOCALES, getLocale, isLocale, setLocale, t, type Locale, type MessageKey } from '../i18n/index.js';

/** 每次渲染时重建,使 /lang 与配置中的语言设置都能生效。 */
function buildCommands() {
  return [
    { name: 'help', description: t('cmd.help') },
    { name: 'model', description: t('cmd.model') },
    { name: 'provider', description: t('cmd.provider') },
    { name: 'mode', description: t('cmd.mode') },
    { name: 'think', description: t('cmd.think') },
    { name: 'lang', description: t('cmd.lang') },
    { name: 'statusbar', description: t('cmd.statusbar'), multi: true },
    { name: 'compact', description: t('cmd.compact') },
    { name: 'new', description: t('cmd.new') },
    { name: 'clear', description: t('cmd.clear') },
    { name: 'mcp', description: t('cmd.mcp') },
    { name: 'cost', description: t('cmd.cost') },
    { name: 'resume', description: t('cmd.resume') },
    { name: 'exit', description: t('cmd.exit') },
  ];
}

const MODE_DESCRIPTIONS: Record<PermissionMode, MessageKey> = {
  readonly: 'modeopt.readonly',
  ask: 'modeopt.ask',
  acceptEdits: 'modeopt.acceptEdits',
  yolo: 'modeopt.yolo',
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
const BUSY_BLOCKED_COMMANDS = new Set(['new', 'clear', 'compact', 'model', 'provider', 'resume']);

const SEGMENT_DESCRIPTIONS: Record<StatusSegment, MessageKey> = {
  mode: 'statusopt.mode',
  model: 'statusopt.model',
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
 */
const STREAM_PREVIEW_ROWS = 5;
const REASONING_PREVIEW_ROWS = 3;
/** 留给状态行、输入框、信息栏、进行中的工具行和各处 marginTop 的余量。 */
const RESERVED_ROWS = 13;

let itemCounter = 0;
const nextKey = () => `item-${itemCounter++}`;

/**
 * 恢复会话时的初始时间线:一条 divider + 完整回放。空会话返回空数组,
 * Header 照常显示(items 非空即隐藏 Header)。
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

  // 惰性初始化:`kdg -r` 恢复的会话在首帧就带着回放的历史时间线。
  const [items, setItems] = useState<TimelineItem[]>(() => buildResumeItems(session));
  /**
   * 每次清空时间线时递增,作为 <Static> 的 key 强制重挂载。
   *
   * Ink 自己攒了一份 fullStaticOutput,只在 <Static> 节点身份变化时才重置,
   * 并会在任何撑出视口的帧、以及终端恢复时原样重播它。只把 items 置空不换
   * 节点身份,于是 /clear 之后随便来一帧高内容(大 diff 的授权框、窄窗口下
   * 的长预览)就会把清掉的整份记录重新打回屏幕。
   */
  const [staticEpoch, setStaticEpoch] = useState(0);
  const [activeText, setActiveText] = useState('');
  const [activeReasoning, setActiveReasoning] = useState('');
  const [activeTools, setActiveTools] = useState<ActiveToolCall[]>([]);
  const [permission, setPermission] = useState<PermissionRequest | undefined>();
  const [running, setRunning] = useState(false);
  // 工作状态:undefined 表示空闲(状态行隐藏)。since 在整轮工作中保持
  // 不变,阶段切换只更新文字和颜色,已用时连续累计。
  const [work, setWork] = useState<WorkState | undefined>(undefined);
  // 从 store 取初值:恢复会话时 restoreState 在 bootstrap 阶段就填好了
  // todos,那时还没有订阅者,只靠 subscribe 的话要等模型下次调 todo 工具
  // 才显示。
  const [todos, setTodos] = useState<TodoItem[]>(() => session.todos.get());
  const [usage, setUsage] = useState({ used: 0, window: session.provider.contextWindow, total: 0 });
  const [providerLabel, setProviderLabel] = useState(session.provider.label);
  const [model, setModel] = useState(session.provider.model);
  const [mode, setMode] = useState(session.config.permissionMode);
  const [think, setThink] = useState<ReasoningEffort>(session.provider.reasoningEffort);
  const [ctrlCArmed, setCtrlCArmed] = useState(false);
  const [locale, setLocaleState] = useState(getLocale());
  const [statusSegments, setStatusSegments] = useState<StatusSegment[]>(session.config.statusBar);
  // esc-esc 回退:第一次 esc 预备(footer 提示),第二次打开回退选择器。
  const [escArmed, setEscArmed] = useState(false);
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

  // 当前流式文本块是否已有段落提前定稿(增量提交):后续片段渲染时
  // 不再带 ● 前缀,只缩进对齐。
  const textCommitted = useRef(false);

  // `tool-end` 不携带调用的输入,所以在 `tool-start` 时先记下来。
  const toolInputs = useRef(new Map<string, unknown>());

  const ctrlCTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const escTimer = useRef<NodeJS.Timeout | undefined>(undefined);

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
    const flushReasoning = () => {
      const text = activeReasoningRef.current;
      activeReasoningRef.current = '';
      setActiveReasoning('');
      if (text.trim()) push({ kind: 'reasoning', text: text.trim() });
    };
    // 中断(Esc)和流级异常不会给进行中的文本块补发 text-end/reasoning-end
    // (SDK 直接关闭流),已生成的部分回答必须在这里定稿,否则它永远进不了
    // 时间线,还会残留在累积区、被拼进下一轮的回答。进行中的工具行同样
    // 等不到 tool-end,一并清掉——结果若之后仍到达,tool-end 照常落时间线。
    const flushInterrupted = () => {
      flushReasoning();
      flushText();
      setActiveTools([]);
    };

    const off = session.bus.on((event: AgentEvent) => {
      switch (event.type) {
        case 'turn-start':
          push({ kind: 'user', text: event.userText });
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
          activeReasoningRef.current += event.text;
          setActiveReasoning(activeReasoningRef.current);
          beginWork('thinking');
          break;
        case 'reasoning-end':
          flushReasoning();
          break;

        case 'tool-start':
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

        case 'permission-request':
          setPermission(event.request);
          beginWork('waiting');
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
          endWork();
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

  useEffect(() => () => {
    if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
    if (escTimer.current) clearTimeout(escTimer.current);
  }, []);

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

  /** esc 的总入口:运行中 → 中断;空闲二连 esc → 回退选择器。 */
  const handleEscape = useCallback(() => {
    if (session.agent.isRunning) {
      session.agent.abort();
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
      resetTimeline(replayed);
      // 上下文用量归零:历史刚变短,旧数字会一直挂到下一轮 step-end。
      // 累计消耗保留——那些 token 确实花掉了。
      setUsage((prev) => ({ ...prev, used: 0 }));
      push({ kind: 'notice', level: 'info', message: t('notice.rewound', { n: entry.ordinal }) });
      // 原消息放回输入框,编辑后重发即分叉出新的走向。
      setPrefill({ text: entry.text });
    },
    [session, push, resetTimeline],
  );


  const runCommand = useCallback(
    async (raw: string) => {
      const [name, ...rest] = raw.slice(1).trim().split(/\s+/);
      const arg = rest.join(' ');

      // 这些命令会改写正在被进行中的流读写的历史/模型,运行中禁止。
      // 压缩没有 controller,isRunning 期间为 false——不把它算进来的话,
      // /compact 等待摘要返回时还能执行 /clear,压缩随后会把已丢弃的对话
      // 写回内存,并存进那个全新的会话文件。
      const busy = session.agent.isRunning || session.agent.isCompacting;
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
              .map((c) => `/${c.name} — ${c.description}`)
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
          // 清空时间线让 Header 重新出现,和启动时的界面一致。
          setItems([]);
          // 同时换掉 <Static> 的身份,让 ink 丢掉已累积的静态输出。
          setStaticEpoch((epoch) => epoch + 1);
          setUsage((prev) => ({ ...prev, used: 0, total: 0 }));
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

        case 'mode': {
          const parsed = permissionModeSchema.safeParse(arg);
          if (!parsed.success) {
            push({
              kind: 'notice',
              level: 'warn',
              message: t('notice.modeUsage', { mode }),
            });
            break;
          }
          session.setMode(parsed.data);
          setMode(parsed.data);
          push({ kind: 'notice', level: 'info', message: t('notice.modeSet', { mode: parsed.data }) });
          // 落盘范围是本工作区的 .kdg/config.json;yolo 不保存,提示它只管这一次。
          const saved = await saveMode(session.root, parsed.data).catch((err: Error) => {
            push({ kind: 'notice', level: 'warn', message: t('notice.modeSaveFailed', { message: err.message }) });
            return undefined;
          });
          if (parsed.data === 'yolo') {
            push({ kind: 'notice', level: 'warn', message: t('notice.modeSessionOnly') });
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

        case 'cost':
          push({
            kind: 'notice',
            level: 'info',
            message:
              `${t('notice.costSession', { total: usage.total })}\n` +
              `${t('notice.costContext', { used: usage.used, window: usage.window })}\n` +
              t('notice.costTranscript', { path: `~/.kdg/sessions/${session.store.id}.jsonl` }),
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
          resetTimeline(buildResumeItems(session));
          // 同步 UI 状态:mode/provider/model 可能都被恢复改写;上下文用量
          // 归零,下一轮 step-end 会带回真实值。todos 由订阅自动更新。
          setMode(session.config.permissionMode);
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
    [session, mode, think, usage, statusSegments, push, exit, writeStdout, resetTimeline],
  );

  // 必须定义在 runCommand 之后并把它列进依赖:否则这里会永久捕获首次渲染
  // 的 runCommand,上面那串依赖形同虚设,命令永远读到启动时的状态快照。
  const handleSubmit = useCallback(
    (text: string) => {
      if (text.startsWith('/')) {
        void runCommand(text);
        return;
      }
      // 工作中提交 → 注入进行中的一轮作为引导;以 agent 的真实运行状态为
      // 准,不依赖可能滞后的 React state。空闲时 inject 返回 false,走正常
      // 新一轮。
      if (session.agent.inject(text)) {
        push({ kind: 'user', text });
        push({ kind: 'notice', level: 'info', message: t('notice.guidanceQueued') });
        return;
      }
      setRunning(true);
      void session.agent.run(text).finally(() => setRunning(false));
    },
    [session, runCommand, push],
  );

  // 枚举参数的取值来源:在命令菜单上回车会进入二级选择器。
  const commands = useMemo<SlashCommand[]>(() => {
    const optionSources: Record<string, SlashCommand['options']> = {
      mode: () =>
        permissionModeSchema.options.map((m) => ({
          value: m,
          label: t(MODE_DESCRIPTIONS[m]),
          current: m === mode,
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
  }, [locale, mode, think, model, providerLabel, statusSegments, session]);

  const mcpSummary = useMemo(() => {
    if (session.mcpStatuses.length === 0) return undefined;
    const ok = session.mcpStatuses.filter((s) => s.connected).length;
    return `${ok}/${session.mcpStatuses.length}`;
  }, [session.mcpStatuses]);

  // 预览高度按实际终端尺寸收敛,窄/矮窗口下也不会撑爆动态区域。
  const columns = stdout?.columns ?? 80;
  const budget = Math.max(1, (stdout?.rows ?? 24) - RESERVED_ROWS);
  const textRows = Math.min(STREAM_PREVIEW_ROWS, budget);
  const reasoningRows = Math.min(REASONING_PREVIEW_ROWS, budget);

  return (
    <Box flexDirection="column">
      {/* 已完成的条目只渲染一次,留在终端回滚缓冲区中。 */}
      <Static key={staticEpoch} items={items}>
        {(item) => <TimelineEntry key={item.key} item={item} />}
      </Static>

      <Box flexDirection="column" marginTop={1}>
        {items.length === 0 ? (
          <Header
            providerLabel={providerLabel}
            model={model}
            root={session.root}
            mode={mode}
            mcpSummary={mcpSummary}
          />
        ) : null}

        {activeReasoning.trim() ? (
          <Box marginTop={1}>
            <Text color={theme.dim} italic>
              {tailWithinRows(activeReasoning, reasoningRows, columns)}
            </Text>
          </Box>
        ) : null}

        {activeText.trim() ? (
          <Box marginTop={1}>
            <Text color={theme.assistant}>{glyphs.bullet} </Text>
            <Box flexDirection="column" flexGrow={1}>
              {/* 前缀 ● 占两列,预览宽度相应收窄。 */}
              <Markdown text={tailWithinRows(activeText, textRows, columns - 2)} />
            </Box>
          </Box>
        ) : null}

        {activeTools.map((call) => (
          <Box key={call.callId} marginTop={1}>
            <Text color={theme.tool}>{glyphs.running} </Text>
            <Text bold>{call.toolName}</Text>
            <Text color={theme.dim}>({formatToolInput(call.toolName, call.input)})</Text>
          </Box>
        ))}

        {/* 工作状态行:主流 CLI 的位置——流式内容/工具行之下、输入框之上。 */}
        {work ? <StatusLine phase={work.phase} detail={work.detail} since={work.since} /> : null}

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
            <Input
              onSubmit={handleSubmit}
              disabled={false}
              placeholder={running || work ? t('input.steer') : t('input.placeholder')}
              commands={commands}
              onEscape={handleEscape}
              prefill={prefill}
              onPrefillConsumed={clearPrefill}
            />
            <Footer
              contextUsed={usage.used}
              contextWindow={usage.window}
              cumulativeTokens={usage.total}
              todos={todos}
              model={model}
              mode={mode}
              think={think}
              segments={statusSegments}
              notice={
                ctrlCArmed
                  ? t('status.ctrlcAgain')
                  : escArmed
                    ? t('status.escAgainRewind')
                    : undefined
              }
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}

