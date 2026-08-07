import { createMemo, type JSX as SolidJSX } from 'solid-js';
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
  /** 显示哪些信息段,由 /statusbar 配置。 */
  segments: StatusSegment[];
  /** 临时提醒(如"再按一次 ctrl+c 退出"),有值时以醒目颜色展示。 */
  notice?: string;
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

    const parts: SolidJSX.Element[] = [];
    if (show.has('mode')) {
      // 与 Header 共用同一套配色,见 theme.modeColor。
      parts.push(<Text color={modeColor(props.mode)}>{props.mode}</Text>);
    }
    if (show.has('model')) {
      parts.push(<Text color={theme.dim}>{props.model}</Text>);
    }
    if (show.has('cwd')) {
      parts.push(<Text color={theme.dim}>{truncateWidthStart(shortenHome(props.root), 40)}</Text>);
    }
    // auto 是默认状态,显示出来只是噪音——仿 todos 的"非空才显示"。
    if (show.has('think') && props.think !== 'auto') {
      parts.push(<Text color={theme.dim}>{t('footer.think', { level: props.think })}</Text>);
    }
    if (show.has('context')) {
      parts.push(
        <Text color={theme.dim}>
          {t('footer.ctx')}{' '}
          <Text color={pct > 0.85 ? theme.warn : theme.dim}>
            {formatTokens(props.contextUsed)}/{formatTokens(props.contextWindow)}
          </Text>
        </Text>,
      );
    }
    if (show.has('total')) {
      parts.push(
        <Text color={theme.dim}>{t('footer.total', { n: formatTokens(props.cumulativeTokens) })}</Text>,
      );
    }

    const showTodos = show.has('todos') && props.todos.length > 0;
    if (!props.notice && !showTodos && parts.length === 0) return null;

    return (
      <Box flexDirection="column">
        {showTodos ? (
          <Box>
            <Text color={active ? theme.accent : theme.dim}>
              {done === props.todos.length ? glyphs.checked : glyphs.unchecked} {done}/{props.todos.length}
            </Text>
            {active ? (
              <Text color={theme.accent}> {truncateWidth(active.content, 60)}</Text>
            ) : (
              <Text color={theme.dim}> {t('footer.tasks')}</Text>
            )}
          </Box>
        ) : null}
        {props.notice ? <Text color={theme.warn}>{props.notice}</Text> : null}
        {parts.length > 0 ? (
          <Box>
            {parts.map((part, i) => (
              <>
                {i > 0 ? <Text color={theme.dim}> · </Text> : null}
                {part}
              </>
            ))}
          </Box>
        ) : null}
      </Box>
    );
  });
  return <>{view()}</>;
}
