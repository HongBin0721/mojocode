import React from 'react';
import { Box, Text } from 'ink';
import { theme, glyphs, formatTokens, truncateWidth } from './theme.js';
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
 */
export function Footer({
  contextUsed,
  contextWindow,
  cumulativeTokens,
  todos,
  model,
  mode,
  think,
  segments,
  notice,
}: Props): React.ReactElement | null {
  const show = new Set(segments);
  const pct = contextWindow > 0 ? contextUsed / contextWindow : 0;
  const active = todos.find((t) => t.status === 'in_progress');
  const done = todos.filter((t) => t.status === 'completed').length;

  const parts: React.ReactElement[] = [];
  if (show.has('mode')) {
    // 与 Header 一致:yolo 用警示色,其余用弱化色。
    parts.push(
      <Text key="mode" color={mode === 'yolo' ? theme.warn : theme.dim}>
        {mode}
      </Text>,
    );
  }
  if (show.has('model')) {
    parts.push(
      <Text key="model" color={theme.dim}>
        {model}
      </Text>,
    );
  }
  // auto 是默认状态,显示出来只是噪音——仿 todos 的"非空才显示"。
  if (show.has('think') && think !== 'auto') {
    parts.push(
      <Text key="think" color={theme.dim}>
        {t('footer.think', { level: think })}
      </Text>,
    );
  }
  if (show.has('context')) {
    parts.push(
      <Text key="context" color={theme.dim}>
        {t('footer.ctx')}{' '}
        <Text color={pct > 0.85 ? theme.warn : theme.dim}>
          {formatTokens(contextUsed)}/{formatTokens(contextWindow)}
        </Text>
      </Text>,
    );
  }
  if (show.has('total')) {
    parts.push(
      <Text key="total" color={theme.dim}>
        {t('footer.total', { n: formatTokens(cumulativeTokens) })}
      </Text>,
    );
  }

  const showTodos = show.has('todos') && todos.length > 0;
  if (!notice && !showTodos && parts.length === 0) return null;

  return (
    <Box flexDirection="column">
      {showTodos ? (
        <Box>
          <Text color={active ? theme.accent : theme.dim}>
            {done === todos.length ? glyphs.checked : glyphs.unchecked} {done}/{todos.length}
          </Text>
          {active ? (
            <Text color={theme.accent}> {truncateWidth(active.content, 60)}</Text>
          ) : (
            <Text color={theme.dim}> {t('footer.tasks')}</Text>
          )}
        </Box>
      ) : null}
      {notice ? <Text color={theme.warn}>{notice}</Text> : null}
      {parts.length > 0 ? (
        <Box>
          {parts.map((part, i) => (
            <React.Fragment key={part.key}>
              {i > 0 ? <Text color={theme.dim}> · </Text> : null}
              {part}
            </React.Fragment>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
