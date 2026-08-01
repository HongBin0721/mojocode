import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { Header } from './Header.js';
import { Footer } from './Footer.js';
import { Input, type CommandOption, type SlashCommand } from './Input.js';
import { TimelineEntry } from './Timeline.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { theme, glyphs, formatToolInput } from './theme.js';
import { Markdown } from './Markdown.js';
import { tailWithinRows } from './preview.js';
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
/** 留给输入框、状态栏、进行中的工具行和各处 marginTop 的余量。 */
const RESERVED_ROWS = 12;

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
  const [status, setStatus] = useState(() => t('status.ready'));
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

  // `tool-end` 不携带调用的输入,所以在 `tool-start` 时先记下来。
  const toolInputs = useRef(new Map<string, unknown>());

  const ctrlCTimer = useRef<NodeJS.Timeout | undefined>(undefined);

  const push = useCallback((item: NewTimelineItem) => {
    setItems((prev) => [...prev, { ...item, key: nextKey() } as TimelineItem]);
  }, []);

  // 把 agent 的事件总线接入 React 状态。
  useEffect(() => {
    const off = session.bus.on((event: AgentEvent) => {
      switch (event.type) {
        case 'turn-start':
          push({ kind: 'user', text: event.userText });
          setStatus(t('status.thinking'));
          break;

        case 'text-delta':
          setActiveText((prev) => prev + event.text);
          setStatus(t('status.responding'));
          break;
        case 'text-end':
          setActiveText((prev) => {
            if (prev.trim()) push({ kind: 'assistant', text: prev.trimEnd() });
            return '';
          });
          break;

        case 'reasoning-delta':
          setActiveReasoning((prev) => prev + event.text);
          setStatus(t('status.thinking'));
          break;
        case 'reasoning-end':
          setActiveReasoning((prev) => {
            if (prev.trim()) push({ kind: 'reasoning', text: prev.trim() });
            return '';
          });
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
          setStatus(t('status.runningTool', { tool: event.toolName }));
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
          setStatus(t('status.thinking'));
          break;
        }

        case 'permission-request':
          setPermission(event.request);
          setStatus(t('status.waiting'));
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
          setStatus(t('status.ready'));
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
          push({ kind: 'error', message: event.error.message });
          setStatus(t('status.ready'));
          break;

        case 'aborted':
          push({ kind: 'notice', level: 'warn', message: t('notice.interrupted') });
          setStatus(t('status.ready'));
          break;

        default:
          break;
      }
    });

    return off;
  }, [session.bus, push]);

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

  useInput(
    (input, key) => {
      if (key.escape && running) {
        session.agent.abort();
      }
    },
    { isActive: permission === undefined },
  );

  const runCommand = useCallback(
    async (raw: string) => {
      const [name, ...rest] = raw.slice(1).trim().split(/\s+/);
      const arg = rest.join(' ');

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
          setStatus(t('status.compacting'));
          setRunning(true);
          await session.agent.compact().catch((err: Error) => {
            push({ kind: 'error', message: t('notice.compactFailed', { message: err.message }) });
          });
          setRunning(false);
          setStatus(t('status.ready'));
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
          setStatus(t('status.ready'));
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
            setStatus(t('status.listingModels'));
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
            setStatus(t('status.ready'));
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
      setRunning(true);
      void session.agent.run(text).finally(() => setRunning(false));
    },
    [session, runCommand],
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

        {permission ? (
          <PermissionPrompt request={permission} onDecide={onDecide} />
        ) : (
          <Box flexDirection="column" marginTop={1}>
            <Input
              onSubmit={handleSubmit}
              disabled={running}
              placeholder={running ? t('input.working') : t('input.placeholder')}
              commands={commands}
            />
            <Footer
              contextUsed={usage.used}
              contextWindow={usage.window}
              cumulativeTokens={usage.total}
              todos={todos}
              status={ctrlCArmed ? t('status.ctrlcAgain') : status}
              model={model}
              segments={statusSegments}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}

