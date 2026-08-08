import { createMemo, type JSX as SolidJSX } from 'solid-js';
import stringWidth from 'string-width';
import { Box, Text, type JSX } from './kit.js';
import { theme, glyphs, formatTokens, truncateWidth, truncateWidthStart, modeColor, shortenHome } from './theme.js';
import type { TodoItem } from '../tools/index.js';
import type { StatusSegment } from '../config/schema.js';
import { t } from '../i18n/index.js';

interface Props {
  contextUsed: number;
  contextWindow: number;
  cumulativeTokens: number;
  todos: TodoItem[];
  model: string;
  /** 当前权限模式,启用 mode 段时显示在最前。 */
  mode: string;
  /** 当前工作区根目录,启用 cwd 段时以 `~` 缩写展示。 */
  root: string;
  /** 当前思考强度,auto(默认)时不占位。 */
  think: string;
  /** 显示哪些信息段,在 /setting 设置面板里配置。 */
  segments: StatusSegment[];
  /** 终端列数。整行绝不能超宽,见 fitParts 的说明。 */
  columns: number;
  /** 临时提醒(如"再按一次 ctrl+c 退出"),有值时以醒目颜色展示。 */
  notice?: string;
}

const SEP_WIDTH = 3;
/** cwd 段的常规上限;放得下就按它截,放不下再动态收窄。 */
const CWD_WIDTH = 40;
/** 路径收到比这还短就没有信息量了,那时改为独占一行。 */
const MIN_CWD_WIDTH = 16;
/**
 * 一行装不下时的丢弃顺序(先丢前面的)。mode 排最后:它是"此刻能不能
 * 改你的文件",任何时候都比 token 计数重要。
 */
const DROP_ORDER: StatusSegment[] = ['total', 'think', 'context', 'model', 'cwd', 'mode'];

interface Part {
  id: StatusSegment;
  /** 量宽用的纯文本(不含着色)。 */
  plain: string;
  /** 按给定文本渲染这一段——收窄后要保住原来的配色。 */
  render: (text: string) => SolidJSX.Element;
}

const rowWidth = (parts: Part[]): number =>
  parts.reduce((sum, part) => sum + stringWidth(part.plain), 0) +
  SEP_WIDTH * Math.max(0, parts.length - 1);

/** 把一段重新截到给定宽度:路径保尾部(尾部才是重点),其余保头部。 */
function shrink(part: Part, width: number): Part {
  const text =
    part.id === 'cwd' ? truncateWidthStart(part.plain, width) : truncateWidth(part.plain, width);
  return { ...part, plain: text };
}

/**
 * 把信息段裁到每行都装得下,返回按行分组的结果。
 *
 * 必须显式裁:OpenTUI 的 flex 行超宽时收缩的是子节点本身,分隔符两侧的
 * 空格会被吃掉(110 列下实测渲染成 `full-access· kimi-k3 · …/demo· 思考
 * max ·上下文`),既难看又看不出是被截断的。策略:先把路径收窄到剩余
 * 空间,收窄到没有信息量时让它独占一行(信息不丢),仍装不下才按
 * DROP_ORDER 丢段,最后兜底硬截。
 */
export function fitParts(parts: Part[], available: number): Part[][] {
  const rows: Part[][] = [];
  let row = [...parts];

  const cwdIndex = row.findIndex((part) => part.id === 'cwd');
  if (cwdIndex >= 0 && rowWidth(row) > available) {
    const cwd = row[cwdIndex]!;
    const others = row.filter((_, i) => i !== cwdIndex);
    const budget = available - rowWidth(others) - (others.length > 0 ? SEP_WIDTH : 0);
    if (budget >= MIN_CWD_WIDTH) {
      row = row.map((part, i) => (i === cwdIndex ? shrink(cwd, budget) : part));
    } else if (available >= MIN_CWD_WIDTH) {
      rows.push([shrink(cwd, available)]);
      row = others;
    } else {
      // 整行都放不下一个有信息量的路径:独占一行也是一行「…」,不如不要。
      row = others;
    }
  }

  for (const id of DROP_ORDER) {
    if (rowWidth(row) <= available || row.length <= 1) break;
    row = row.filter((part) => part.id !== id);
  }
  // 兜底两步,合起来让"装得下"与 DROP_ORDER 是否列全无关:新增一种信息段
  // 却忘了登记时,行仍然被截到宽度以内,而不是交给 OpenTUI 去吞分隔符。
  while (row.length > 1 && rowWidth(row) > available) row = row.slice(0, -1);
  if (row.length === 1 && rowWidth(row) > available) row = [shrink(row[0]!, available)];

  if (row.length > 0) rows.push(row);
  return rows;
}

/**
 * 输入框下方的信息栏。工作状态已移到输入框上方的 StatusLine,这里只
 * 剩可配置的信息段;全部关闭且无提醒时整个组件不渲染,不占行。
 *
 * 整体收进一个 memo 粗粒度重建:信息段之间有分隔符插入逻辑,细粒度追踪
 * 不值得——它只有几行文本,任何 prop 变了整体重算一次即可。
 */
export function Footer(props: Props): JSX.Element {
  const view = createMemo<SolidJSX.Element>(() => {
    const show = new Set(props.segments);
    const pct = props.contextWindow > 0 ? props.contextUsed / props.contextWindow : 0;
    const active = props.todos.find((todo) => todo.status === 'in_progress');
    const done = props.todos.filter((todo) => todo.status === 'completed').length;
    // 留 1 列余量:顶满最后一列在部分终端上会触发自动换行。下限只防退化成
    // 0/负数——**不能**用一个固定下限(如 20),那会在更窄的终端上把预算抬到
    // 实际宽度以上,每一处裁剪都按看不见的宽度裁,底栏反而折成好几行。
    const available = Math.max(1, props.columns - 1);

    const parts: Part[] = [];
    if (show.has('mode')) {
      // 与 Header 共用同一套配色,见 theme.modeColor。
      parts.push({
        id: 'mode',
        plain: props.mode,
        render: (text) => <Text color={modeColor(props.mode)}>{text}</Text>,
      });
    }
    if (show.has('model')) {
      parts.push({
        id: 'model',
        plain: props.model,
        render: (text) => <Text color={theme.dim}>{text}</Text>,
      });
    }
    if (show.has('cwd')) {
      parts.push({
        id: 'cwd',
        plain: truncateWidthStart(shortenHome(props.root), CWD_WIDTH),
        render: (text) => <Text color={theme.dim}>{text}</Text>,
      });
    }
    // auto 是默认状态,显示出来只是噪音——仿 todos 的"非空才显示"。
    if (show.has('think') && props.think !== 'auto') {
      parts.push({
        id: 'think',
        plain: t('footer.think', { level: props.think }),
        render: (text) => <Text color={theme.dim}>{text}</Text>,
      });
    }
    if (show.has('context')) {
      const counts = `${formatTokens(props.contextUsed)}/${formatTokens(props.contextWindow)}`;
      parts.push({
        id: 'context',
        plain: `${t('footer.ctx')} ${counts}`,
        // 收窄时会退化成整段一个颜色;正常宽度下用量单独着色,逼近上限时变警示色。
        render: (text) =>
          text.endsWith(counts) ? (
            <Text color={theme.dim}>
              {text.slice(0, text.length - counts.length)}
              <Text color={pct > 0.85 ? theme.warn : theme.dim}>{counts}</Text>
            </Text>
          ) : (
            <Text color={theme.dim}>{text}</Text>
          ),
      });
    }
    if (show.has('total')) {
      parts.push({
        id: 'total',
        plain: t('footer.total', { n: formatTokens(props.cumulativeTokens) }),
        render: (text) => <Text color={theme.dim}>{text}</Text>,
      });
    }

    const showTodos = show.has('todos') && props.todos.length > 0;
    if (!props.notice && !showTodos && parts.length === 0) return null;

    const rows = fitParts(parts, available);
    // 任务摘要与提醒同样不能超宽(窄终端下会被挤成两行,把输入框顶上去)。
    // 计数在前、说明在后:宽度不够时先牺牲说明,连计数都放不下才截计数。
    const todoHead = truncateWidth(
      `${done === props.todos.length ? glyphs.checked : glyphs.unchecked} ${done}/${props.todos.length}`,
      available,
    );
    const todoBudget = available - stringWidth(todoHead) - 1;
    const todoTail =
      todoBudget > 0
        ? truncateWidth(active ? active.content : t('footer.tasks'), todoBudget)
        : '';

    return (
      <Box flexDirection="column">
        {showTodos ? (
          <Box>
            <Text color={active ? theme.accent : theme.dim}>{todoHead}</Text>
            {todoTail ? (
              <Text color={active ? theme.accent : theme.dim}> {todoTail}</Text>
            ) : null}
          </Box>
        ) : null}
        {props.notice ? (
          <Text color={theme.warn}>{truncateWidth(props.notice, available)}</Text>
        ) : null}
        {rows.map((row) => (
          <Box>
            {row.map((part, i) => (
              <>
                {i > 0 ? <Text color={theme.dim}> · </Text> : null}
                {part.render(part.plain)}
              </>
            ))}
          </Box>
        ))}
      </Box>
    );
  });
  return <>{view()}</>;
}
