import React from 'react';
import { Box, Text, useInput } from 'ink';
import { Diff } from './Diff.js';
import { theme } from './theme.js';
import type { PermissionDecision, PermissionRequest } from '../core/events.js';
import { t } from '../i18n/index.js';

interface Props {
  request: PermissionRequest;
  onDecide: (decision: PermissionDecision) => void;
}

export function PermissionPrompt({ request, onDecide }: Props): React.ReactElement {
  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === 'y' || key.return) {
      onDecide({ type: 'allow' });
    } else if (ch === 'n' || key.escape) {
      onDecide({ type: 'deny' });
    } else if (input === 'a' && request.suggestedRule) {
      onDecide({ type: 'allow-always', rule: request.suggestedRule });
    } else if (input === 'A' && request.suggestedRule) {
      onDecide({ type: 'allow-persist', rule: request.suggestedRule });
    }
  });

  const isDiff = request.detail?.includes('@@') ?? false;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warn}
      paddingX={1}
      marginTop={1}
    >
      <Text bold color={theme.warn}>
        {t('perm.title')}
      </Text>
      <Text>{request.title}</Text>

      {request.detail ? (
        <Box marginTop={1} flexDirection="column">
          {isDiff ? (
            <Diff patch={request.detail} maxLines={20} />
          ) : (
            <Text color={theme.dim}>{clamp(request.detail, 20)}</Text>
          )}
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color={theme.success}>y</Text>
          <Text color={theme.dim}> {t('perm.allowOnce')} · </Text>
          <Text color={theme.error}>n</Text>
          <Text color={theme.dim}> {t('perm.deny')}</Text>
        </Text>
        {request.suggestedRule ? (
          <Text color={theme.dim}>
            <Text color={theme.accent}>a</Text> {t('perm.alwaysSession')} ·{' '}
            <Text color={theme.accent}>A</Text> {t('perm.alwaysPersist')}{' '}
            <Text color={theme.dim}>({request.suggestedRule})</Text>
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

function clamp(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join('\n')}\n${t('ui.moreLines', { n: lines.length - maxLines })}`;
}
