import React from 'react';
import { Box, Text } from 'ink';
import { theme, modeColor, shortenHome } from './theme.js';
import { APP_NAME } from '../config/paths.js';
import { t } from '../i18n/index.js';

interface Props {
  providerLabel: string;
  model: string;
  root: string;
  mode: string;
  mcpSummary?: string;
}

export function Header({ providerLabel, model, root, mode, mcpSummary }: Props): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Box>
        <Text bold color={theme.accent}>
          {APP_NAME}
        </Text>
        <Text color={theme.dim}> · </Text>
        <Text>{providerLabel}</Text>
        <Text color={theme.dim}> · </Text>
        <Text color={theme.accent}>{model}</Text>
        {mode !== 'ask' ? (
          <>
            <Text color={theme.dim}> · </Text>
            <Text color={modeColor(mode)}>{mode}</Text>
          </>
        ) : null}
      </Box>
      <Box>
        <Text color={theme.dim}>{shortenHome(root)}</Text>
        {mcpSummary ? <Text color={theme.dim}> · mcp: {mcpSummary}</Text> : null}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>{t('header.hints')}</Text>
      </Box>
    </Box>
  );
}
