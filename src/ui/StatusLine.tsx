import { createMemo, createSignal, onCleanup } from 'solid-js';
import stringWidth from 'string-width';
import { Text, type JSX } from './kit.js';
import { theme, formatTokens, meterBar, toolDisplayName, truncateWidth } from './theme.js';
import { t, type MessageKey } from '../i18n/index.js';

/** 工作阶段。 */
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
  /**
   * 进度(0–1),有值时在阶段名后画一条 ▰▱ 进度条。目前只有压缩用:摘要
   * 总长事先未知,由 App 按典型长度估算并封顶在 99%,收尾事件到达即熄灯,
   * 所以条永远不会自己走到满格(与 Footer 的 meterBar「满格=到顶」同语义)。
   */
  progress?: number;
  /** 本轮工作的起始时刻,用于显示已用时。 */
  since: number;
}

interface Props {
  /** 工作状态。空闲不是这个组件的形态——那时调用方画 IdleRule。 */
  work: WorkState;
  /** 有任务清单时在提示里加上 ctrl+t 开关说明;undefined 表示没有清单。 */
  todoHint?: 'show' | 'hide';
  /**
   * 本轮到目前为止产生的 token。每步收尾刷新一次,0 表示第一步还没跑完
   * ——那时不显示,免得看着像"一直是 0"。
   */
  tokens?: number;
  /** 终端列数,整行按它铺满:标题之后的线一直画到行尾。 */
  columns: number;
  /**
   * 整行的颜色,缺省用阶段色。输入框传自己的边框色进来——那一句
   * `borderColor()` 同时喂给顶线与底边,「这条线就是框的边」因此是一个
   * 表达式用两处,而不是两条各自演化的规则。
   */
  color?: string;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const FRAME_MS = 100;

/** 进度条格数,与 Footer 的上下文表同宽,视觉上是同一族。 */
const BAR_CELLS = 10;

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

const RULE = '─';
/** 标题左侧的引线。 */
const LEAD = `${RULE}${RULE} `;
const LEAD_WIDTH = stringWidth(LEAD);
/** spinner 帧加它后面那个空格。 */
const SPINNER_WIDTH = 2;
/** 标题右侧至少保留 ` ─`:内容顶到行尾会像没画完。 */
const MIN_TRAIL = 2;

/** 阶段色。Input 用它给整个框上色,不必自己再维护一张阶段表。 */
export function phaseColor(phase: WorkPhase): string {
  return PHASE_COLORS[phase];
}

/**
 * 空闲时的输入框顶边:一条铺满整行的纯线。与 StatusLine 是同一条边的两种
 * 形态,由持有这条边的组件(Input)二选一——组件内部因此都不必处理"另一种
 * 形态是什么"。
 */
export function IdleRule(props: { columns: number; color: string }): JSX.Element {
  return (
    <Text color={props.color} wrap="truncate-end">
      {RULE.repeat(Math.max(0, props.columns))}
    </Text>
  );
}

/**
 * 工作中的输入框顶边:把状态嵌进线里(Codex 式)——动画 spinner + 阶段 +
 * 已用时 + 本轮 token + 提示,余下的列补 `─`。定时器同时驱动 spinner 帧和
 * 秒数刷新,组件卸载(回到空闲)即停止。
 *
 * 整行先量后画,标题各段按 DROP_ORDER 丢到装得下为止。刻意不用 OpenTUI
 * 原生的 box `title`:它超宽时整段消失而非截断,且只能一种颜色——尾巴的
 * 弱化色就没了。
 *
 * 这一行铺满整行(含最后一列)是必须的:下方的底边由 OpenTUI 原生绘制,
 * 它就是占满全宽的,顶线短一列会比底边短一截。因此这里不能照 Footer 那样
 * 留 1 列余量,防线改由 `wrap="truncate-end"` 出:string-width 与终端对
 * CJK/歧义宽度字符(`─` `·` 盲文 spinner `▰▱` 全是 Ambiguous)的判定差 1 列
 * 就足以让这行折行,而它每 100ms 重绘一次,折行 = 底部区高度每秒抖一下。
 * 截断把这种分歧降级成右端悄悄少画几格,绝不改变行高。
 */
export function StatusLine(props: Props): JSX.Element {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), FRAME_MS);
  onCleanup(() => clearInterval(timer));

  const frame = () => FRAMES[Math.floor(now() / FRAME_MS) % FRAMES.length]!;
  // 秒数单独成 memo:每 100ms 的滴答里它一秒才变一次,排版(parts)因此不必
  // 跟着 spinner 帧重算。注意这只挡住了定时器这一路——流式期间 beginWork 每
  // 个 delta 都新建一个 WorkState 对象,parts 仍会随之重算,量下来一秒几十次、
  // 几十微秒,可以忽略,别为它再加一层缓存。
  const seconds = createMemo(() => Math.max(0, Math.floor((now() - props.work.since) / 1000)));
  const color = () => props.color ?? PHASE_COLORS[props.work.phase];
  const label = () =>
    props.work.phase === 'tool'
      ? t('status.runningTool', { tool: toolDisplayName(props.work.detail ?? '') })
      : t(PHASE_LABELS[props.work.phase as Exclude<WorkPhase, 'tool'>]);

  /**
   * 整行排版一次算完。拆成一串互相调用的取值函数时,`trail` 要 `tail`、
   * `tail` 在丢弃循环里反复要 `head`、`head` 又要进度条与截断后的阶段名,
   * 一帧下来同样的 stringWidth 要算十几遍;这里按「阶段名 → 进度条 → 尾巴
   * → 补线」一趟走完,每段只量一次。
   */
  const parts = createMemo(() => {
    // 标题(spinner + 阶段 + 进度条 + 尾巴)可占的列数。
    const avail = Math.max(1, props.columns - LEAD_WIDTH - MIN_TRAIL);

    // 头部(spinner 两列 + 阶段)本身就超宽的极窄终端:硬截阶段名,绝不折行。
    const fitted = truncateWidth(label(), Math.max(1, avail - SPINNER_WIDTH));
    let head = SPINNER_WIDTH + stringWidth(fitted);

    // 进度条:` ▰▰▰▱▱▱▱▱▱▱ 42%`。装不下时整条不画(尾部各段随后按 DROP_ORDER
    // 让路),绝不折行、绝不截半条。
    let bar: { filled: string; rest: string } | undefined;
    const progress = props.work.progress;
    if (progress !== undefined) {
      const { filled, empty } = meterBar(progress, BAR_CELLS);
      const pct = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
      const candidate = { filled: ` ${filled}`, rest: `${empty} ${pct}` };
      const width = stringWidth(candidate.filled) + stringWidth(candidate.rest);
      if (head + width <= avail) {
        bar = candidate;
        head += width;
      }
    }

    const segments = new Map<TailId, string>();
    segments.set('elapsed', t('status.elapsed', { s: seconds() }));
    if (props.tokens) segments.set('tokens', t('status.tokens', { n: formatTokens(props.tokens) }));
    if (props.todoHint) {
      segments.set('todo', t(props.todoHint === 'hide' ? 'status.todoHide' : 'status.todoShow'));
    }
    segments.set('interrupt', t('status.interrupt'));

    const joined = () =>
      segments.size > 0 ? SEP + [...segments.values()].join(SEP) : '';
    let tail = joined();
    for (const id of DROP_ORDER) {
      if (head + stringWidth(tail) <= avail) break;
      segments.delete(id);
      tail = joined();
    }
    if (head + stringWidth(tail) > avail) tail = '';

    // 标题之后补到行尾的线。avail 已为 ` ─` 留位,只有极窄终端会空着。
    const rest = props.columns - LEAD_WIDTH - head - stringWidth(tail);
    return { label: fitted, bar, tail, trail: rest >= 2 ? ` ${RULE.repeat(rest - 1)}` : '' };
  });

  return (
    <Text color={color()} wrap="truncate-end">
      {LEAD}
      {frame()}{' '}
      <Text bold>{parts().label}</Text>
      {parts().bar?.filled ?? ''}
      <Text color={theme.dim}>{parts().bar?.rest ?? ''}</Text>
      <Text color={theme.dim}>{parts().tail}</Text>
      {parts().trail}
    </Text>
  );
}
