import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { t } from '../i18n/index.js';

interface Props {
  patch: string;
  maxLines?: number;
}

/** 渲染带 +/- 着色的 unified diff,过长的补丁会折叠。 */
export function Diff({ patch, maxLines = 40 }: Props): React.ReactElement {
  const all = patch.split('\n').filter((line) => !line.startsWith('---') && !line.startsWith('+++'));
  const lines = all.slice(0, maxLines);
  const hidden = all.length - lines.length;

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} color={colorFor(line)} dimColor={line.startsWith('@@')}>
          {line || ' '}
        </Text>
      ))}
      {hidden > 0 && (
        <Text color={theme.dim}>{t('ui.moreDiffLines', { n: hidden })}</Text>
      )}
    </Box>
  );
}

function colorFor(line: string): string | undefined {
  if (line.startsWith('+')) return theme.added;
  if (line.startsWith('-')) return theme.removed;
  if (line.startsWith('@@')) return theme.dim;
  return undefined;
}
