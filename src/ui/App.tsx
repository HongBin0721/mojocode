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
import type { Session } from '../app/bootstrap.js';
import type { TodoItem } from '../tools/index.js';
import {
  STATUS_SEGMENTS,
  permissionModeSchema,
  type PermissionMode,
  type StatusSegment,
} from '../config/schema.js';
import { BUILTIN_PROVIDER_IDS, PROVIDER_PRESETS } from '../config/providers.js';
import { saveLanguage, saveModelChoice, saveProviderChoice, saveStatusBar } from '../config/save.js';
import { listModels } from '../model/registry.js';
import { LOCALES, getLocale, isLocale, setLocale, t, type Locale, type MessageKey } from '../i18n/index.js';

/** 每次渲染时重建,使 /lang 与配置中的语言设置都能生效。 */
function buildCommands() {
  return [
    { name: 'help', description: t('cmd.help') },
    { name: 'model', description: t('cmd.model') },
    { name: 'provider', description: t('cmd.provider') },
    { name: 'mode', description: t('cmd.mode') },
    { name: 'lang', description: t('cmd.lang') },
    { name: 'statusbar', description: t('cmd.statusbar'), multi: true },
    { name: 'compact', description: t('cmd.compact') },
    { name: 'clear', description: t('cmd.clear') },
    { name: 'mcp', description: t('cmd.mcp') },
    { name: 'cost', description: t('cmd.cost') },
    { name: 'exit', description: t('cmd.exit') },
  ];
}

const MODE_DESCRIPTIONS: Record<PermissionMode, MessageKey> = {
  readonly: 'modeopt.readonly',
  ask: 'modeopt.ask',
  acceptEdits: 'modeopt.acceptEdits',
  yolo: 'modeopt.yolo',
};

/** 运行中会和进行中的流互相踩踏的命令(改历史、换模型)。 */
const BUSY_BLOCKED_COMMANDS = new Set(['clear', 'compact', 'model', 'provider']);

const SEGMENT_DESCRIPTIONS: Record<StatusSegment, MessageKey> = {
  model: 'statusopt.model',
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

interface Props {
  session: Session;
}

export function App({ session }: Props): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [items, setItems] = useState<TimelineItem[]>([]);
  const [activeText, setActiveText] = useState('');
  const [activeReasoning, setActiveReasoning] = useState('');
  const [activeTools, setActiveTools] = useState<ActiveToolCall[]>([]);
  const [permission, setPermission] = useState<PermissionRequest | undefined>();
  const [running, setRunning] = useState(false);
  // 工作状态:undefined 表示空闲(状态行隐藏)。since 在整轮工作中保持
  // 不变,阶段切换只更新文字和颜色,已用时连续累计。
  const [work, setWork] = useState<WorkState | undefined>(undefined);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [usage, setUsage] = useState({ used: 0, window: session.provider.contextWindow, total: 0 });
  const [providerLabel, setProviderLabel] = useState(session.provider.label);
  const [model, setModel] = useState(session.provider.model);
  const [mode, setMode] = useState(session.config.permissionMode);
  const [ctrlCArmed, setCtrlCArmed] = useState(false);
  const [locale, setLocaleState] = useState(getLocale());
  const [statusSegments, setStatusSegments] = useState<StatusSegment[]>(session.config.statusBar);

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
  }, []);


  const runCommand = useCallback(
    async (raw: string) => {
      const [name, ...rest] = raw.slice(1).trim().split(/\s+/);
      const arg = rest.join(' ');

      // 这些命令会改写正在被进行中的流读写的历史/模型,运行中禁止。
      if (name && BUSY_BLOCKED_COMMANDS.has(name) && session.agent.isRunning) {
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

        case 'clear':
          session.agent.clear();
          setItems([]);
          setUsage((prev) => ({ ...prev, used: 0 }));
          break;

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

        default:
          push({ kind: 'notice', level: 'warn', message: t('notice.unknownCommand', { name: name ?? '' }) });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, mode, usage, statusSegments, push, exit],
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
    };
    return buildCommands().map((c) => ({ ...c, options: optionSources[c.name] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, mode, model, providerLabel, statusSegments, session]);

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
      <Static items={items}>{(item) => <TimelineEntry key={item.key} item={item} />}</Static>

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
        ) : (
          <Box flexDirection="column" marginTop={1}>
            <Input
              onSubmit={handleSubmit}
              disabled={false}
              placeholder={running || work ? t('input.steer') : t('input.placeholder')}
              commands={commands}
              onEscape={() => {
                if (session.agent.isRunning) session.agent.abort();
              }}
            />
            <Footer
              contextUsed={usage.used}
              contextWindow={usage.window}
              cumulativeTokens={usage.total}
              todos={todos}
              model={model}
              segments={statusSegments}
              notice={ctrlCArmed ? t('status.ctrlcAgain') : undefined}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}

