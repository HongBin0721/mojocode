import React from 'react';
import { Box, Text } from 'ink';
import { theme, glyphs, formatTokens } from './theme.js';
import type { TodoItem } from '../tools/index.js';
import type { StatusSegment } from '../config/schema.js';
import { t } from '../i18n/index.js';

interface Props {
  contextUsed: number;
  contextWindow: number;
  cumulativeTokens: number;
  todos: TodoItem[];
  model: string;
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
  segments,
  notice,
}: Props): React.ReactElement | null {
  const show = new Set(segments);
  const pct = contextWindow > 0 ? contextUsed / contextWindow : 0;
  const active = todos.find((t) => t.status === 'in_progress');
  const done = todos.filter((t) => t.status === 'completed').length;

  const parts: React.ReactElement[] = [];
  if (show.has('model')) {
    parts.push(
      <Text key="model" color={theme.dim}>
        {model}
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
          <Text color={theme.dim}>
            {glyphs.branch} {done}/{todos.length}
          </Text>
          {active ? (
            <Text color={theme.accent}> {active.content.slice(0, 60)}</Text>
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
