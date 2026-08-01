import React from 'react';
import { Box, Text } from 'ink';
import { theme, glyphs, formatTokens } from './theme.js';
import type { TodoItem } from '../tools/index.js';
import { t } from '../i18n/index.js';

interface Props {
  contextUsed: number;
  contextWindow: number;
  cumulativeTokens: number;
  todos: TodoItem[];
  status: string;
}

export function Footer({
  contextUsed,
  contextWindow,
  cumulativeTokens,
  todos,
  status,
}: Props): React.ReactElement {
  const pct = contextWindow > 0 ? contextUsed / contextWindow : 0;
  const active = todos.find((t) => t.status === 'in_progress');
  const done = todos.filter((t) => t.status === 'completed').length;

  return (
    <Box flexDirection="column">
      {todos.length > 0 ? (
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
      <Box>
        <Text color={theme.dim}>{status}</Text>
        <Text color={theme.dim}> · {t('footer.ctx')} </Text>
        <Text color={pct > 0.85 ? theme.warn : theme.dim}>
          {formatTokens(contextUsed)}/{formatTokens(contextWindow)}
        </Text>
        <Text color={theme.dim}> · {t('footer.total', { n: formatTokens(cumulativeTokens) })}</Text>
      </Box>
    </Box>
  );
}
