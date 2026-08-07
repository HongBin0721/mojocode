import { Show } from 'solid-js';
import { Box, Text, type JSX } from './kit.js';
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

export function Header(props: Props): JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Box>
        <Text bold color={theme.accent}>
          {APP_NAME}
        </Text>
        <Text color={theme.dim}> · </Text>
        <Text>{props.providerLabel}</Text>
        <Text color={theme.dim}> · </Text>
        <Text color={theme.accent}>{props.model}</Text>
        <Show when={props.mode !== 'ask'}>
          <Text color={theme.dim}> · </Text>
          <Text color={modeColor(props.mode)}>{props.mode}</Text>
        </Show>
      </Box>
      <Box>
        <Text color={theme.dim}>{shortenHome(props.root)}</Text>
        <Show when={props.mcpSummary}>
          <Text color={theme.dim}> · mcp: {props.mcpSummary}</Text>
        </Show>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>{t('header.hints')}</Text>
      </Box>
    </Box>
  );
}
