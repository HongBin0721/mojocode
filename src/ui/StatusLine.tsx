import { createSignal, onCleanup } from 'solid-js';
import stringWidth from 'string-width';
import { Box, Text, type JSX } from './kit.js';
import { theme, formatTokens, toolDisplayName, truncateWidth } from './theme.js';
import { t, type MessageKey } from '../i18n/index.js';

/** 工作阶段。undefined(空闲)时整行不渲染,由 App 控制。 */
export type WorkPhase =
  | 'thinking'
  | 'responding'
  | 'tool'
  | 'waiting'
  | 'compacting'
  | 'listingModels'
  /** 一轮收尾后,评估器正在判断 `/goal` 的条件达成没有。 */
  | 'evaluating';

export interface WorkState {
  phase: WorkPhase;
  /** 附加信息(目前只有工具名)。 */
  detail?: string;
  /** 本轮工作的起始时刻,用于显示已用时。 */
  since: number;
}

interface Props extends WorkState {
  /** 有任务清单时在提示里加上 ctrl+t 开关说明;undefined 表示没有清单。 */
  todoHint?: 'show' | 'hide';
  /**
   * 本轮到目前为止产生的 token。每步收尾刷新一次,0 表示第一步还没跑完
   * ——那时不显示,免得看着像"一直是 0"。
   */
  tokens?: number;
  /** 终端列数,整行按它裁剪。 */
  columns: number;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const FRAME_MS = 100;

/** 不同阶段用不同颜色,一眼区分在想、在答、在跑工具还是在等人。 */
const PHASE_COLORS: Record<WorkPhase, string> = {
  thinking: 'magenta',
  responding: theme.accent,
  tool: theme.tool,
  waiting: theme.warn,
  compacting: theme.accent,
  listingModels: theme.accent,
  evaluating: 'magenta',
};

const PHASE_LABELS: Record<Exclude<WorkPhase, 'tool'>, MessageKey> = {
  thinking: 'status.thinking',
  responding: 'status.responding',
  waiting: 'status.waiting',
  compacting: 'status.compacting',
  listingModels: 'status.listingModels',
  evaluating: 'status.evaluating',
};

type TailId = 'elapsed' | 'tokens' | 'todo' | 'interrupt';

/** 装不下时的丢弃顺序(先丢前面的)。已用时留到最后:它是"还活着"的证据。 */
const DROP_ORDER: TailId[] = ['todo', 'tokens', 'interrupt', 'elapsed'];

const SEP = ' · ';

/**
 * 输入框上方的工作状态行:动画 spinner + 阶段文字 + 已用时 + 本轮 token +
 * 提示,与主流 CLI(Claude Code / Codex)的布局一致。定时器同时驱动
 * spinner 帧和秒数刷新,组件卸载(回到空闲)即停止。
 *
 * 尾部各段按 DROP_ORDER 丢到装得下为止:这一行随帧重绘,超宽折行会让底部
 * 区域每秒抖一次高度,把时间线顶上去(同 Footer.fitParts 的理由)。
 */
export function StatusLine(props: Props): JSX.Element {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), FRAME_MS);
  onCleanup(() => clearInterval(timer));

  const frame = () => FRAMES[Math.floor(now() / FRAME_MS) % FRAMES.length]!;
  const seconds = () => Math.max(0, Math.floor((now() - props.since) / 1000));
  const color = () => PHASE_COLORS[props.phase];
  const label = () =>
    props.phase === 'tool'
      ? t('status.runningTool', { tool: toolDisplayName(props.detail ?? '') })
      : t(PHASE_LABELS[props.phase as Exclude<WorkPhase, 'tool'>]);

  // 头部(spinner 两列 + 阶段)本身就超宽的极窄终端:硬截阶段名,绝不折行。
  const fittedLabel = () => truncateWidth(label(), Math.max(1, props.columns - 3));
  const headWidth = () => 2 + stringWidth(fittedLabel());

  const tail = (): string => {
    const parts = new Map<TailId, string>();
    parts.set('elapsed', t('status.elapsed', { s: seconds() }));
    if (props.tokens) parts.set('tokens', t('status.tokens', { n: formatTokens(props.tokens) }));
    if (props.todoHint) {
      parts.set('todo', t(props.todoHint === 'hide' ? 'status.todoHide' : 'status.todoShow'));
    }
    parts.set('interrupt', t('status.interrupt'));

    const available = Math.max(1, props.columns - 1);
    const joined = () => [...parts.values()].join(SEP);
    const width = () =>
      headWidth() + (parts.size > 0 ? SEP.length + stringWidth(joined()) : 0);
    for (const id of DROP_ORDER) {
      if (width() <= available) break;
      parts.delete(id);
    }
    return parts.size > 0 && width() <= available ? SEP + joined() : '';
  };

  return (
    <Box marginTop={1}>
      <Text color={color()}>{frame()} </Text>
      <Text color={color()} bold>
        {fittedLabel()}
      </Text>
      <Text color={theme.dim}>{tail()}</Text>
    </Box>
  );
}
