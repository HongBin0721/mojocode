import React from 'react';
import { Box, Text } from 'ink';
import { Diff } from './Diff.js';
import { theme, glyphs, formatDuration, formatToolInput } from './theme.js';
import type { TimelineItem } from './types.js';
import { t } from '../i18n/index.js';

/**
 * One finished timeline entry. Rendered inside Ink's <Static>, so this component
 * is mounted exactly once per item and then never re-rendered — which is what
 * keeps long sessions from crawling.
 */
export function TimelineEntry({ item }: { item: TimelineItem }): React.ReactElement | null {
  switch (item.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={theme.user}>{glyphs.prompt} </Text>
          <Text>{item.text}</Text>
        </Box>
      );

    case 'assistant':
      return (
        <Box marginTop={1} flexDirection="column">
          <Text>{item.text}</Text>
        </Box>
      );

    case 'reasoning':
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.dim} italic>
            {truncateLines(item.text, 8)}
          </Text>
        </Box>
      );

    case 'tool':
      return <ToolEntry item={item} />;

    case 'notice':
      return (
        <Box marginTop={1}>
          <Text color={item.level === 'warn' ? theme.warn : theme.dim}>
            {item.level === 'warn' ? '! ' : '· '}
            {item.message}
          </Text>
        </Box>
      );

    case 'error':
      return (
        <Box marginTop={1}>
          <Text color={theme.error}>
            {glyphs.failed} {item.message}
          </Text>
        </Box>
      );

    case 'divider':
      return (
        <Box marginTop={1}>
          <Text color={theme.dim}>── {item.label} ──</Text>
        </Box>
      );

    default:
      return null;
  }
}

function ToolEntry({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const args = formatToolInput(item.toolName, item.input);
  const diff = extractDiff(item);

  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={item.isError ? theme.error : theme.tool}>{glyphs.bullet} </Text>
        <Text bold>{item.toolName}</Text>
        {args ? <Text color={theme.dim}>({truncateInline(args, 100)})</Text> : null}
      </Box>
      <Box paddingLeft={2}>
        <Text color={theme.dim}>{glyphs.branch} </Text>
        <Text color={item.isError ? theme.error : theme.dim}>
          {truncateInline(item.summary, 160)}
          {/* bash already reports its own duration in the summary. */}
          {!item.isError && item.toolName !== 'bash' && item.durationMs > 1500
            ? ` · ${formatDuration(item.durationMs)}`
            : ''}
        </Text>
      </Box>
      {diff ? (
        <Box paddingLeft={4} flexDirection="column">
          <Diff patch={diff} maxLines={24} />
        </Box>
      ) : null}
      {item.toolName === 'bash' && !item.isError ? (
        <BashOutput output={item.output} />
      ) : null}
    </Box>
  );
}

function BashOutput({ output }: { output: unknown }) {
  const text = (output as { output?: unknown } | undefined)?.output;
  if (typeof text !== 'string' || !text.trim() || text === '(no output)') return null;

  const lines = text.split('\n');
  const shown = lines.slice(0, 12);
  const hidden = lines.length - shown.length;

  return (
    <Box paddingLeft={4} flexDirection="column">
      {shown.map((line, index) => (
        <Text key={index} color={theme.dim}>
          {line.slice(0, 200) || ' '}
        </Text>
      ))}
      {hidden > 0 && <Text color={theme.dim}>{t('ui.moreLines', { n: hidden })}</Text>}
    </Box>
  );
}

function extractDiff(item: Extract<TimelineItem, { kind: 'tool' }>): string | undefined {
  if (item.isError) return undefined;
  const output = item.output as { diff?: unknown } | undefined;
  return typeof output?.diff === 'string' ? output.diff : undefined;
}

function truncateInline(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

function truncateLines(text: string, limit: number): string {
  const lines = text.trim().split('\n');
  if (lines.length <= limit) return text.trim();
  return `${lines.slice(0, limit).join('\n')}\n${t('ui.moreLines', { n: lines.length - limit })}`;
}
