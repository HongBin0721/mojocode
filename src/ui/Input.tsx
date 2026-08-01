import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme, glyphs } from './theme.js';

interface Props {
  onSubmit: (value: string) => void;
  disabled: boolean;
  placeholder: string;
  /** Slash commands offered in the autocomplete strip. */
  commands: Array<{ name: string; description: string }>;
}

/**
 * Prompt line with history, cursor movement and slash-command completion.
 *
 * Hand-rolled instead of ink-text-input because we need multi-line entry
 * (ctrl+j), history recall, and the command palette to share one key handler —
 * layering those on top of a controlled third-party input ends up messier.
 */
export function Input({ onSubmit, disabled, placeholder, commands }: Props): React.ReactElement {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined);

  const showCommands = value.startsWith('/') && !value.includes(' ');
  const matches = showCommands
    ? commands.filter((c) => c.name.startsWith(value.slice(1).toLowerCase())).slice(0, 6)
    : [];

  useInput(
    (input, key) => {
      if (key.return && !key.meta) {
        const trimmed = value.trim();
        if (!trimmed) return;
        setHistory((prev) => [trimmed, ...prev.filter((h) => h !== trimmed)].slice(0, 100));
        setHistoryIndex(undefined);
        setValue('');
        setCursor(0);
        onSubmit(trimmed);
        return;
      }

      // ctrl+j inserts a newline; terminals do not reliably deliver shift+enter.
      if (key.ctrl && input === 'j') {
        insert('\n');
        return;
      }

      if (key.tab && matches.length > 0) {
        const completed = `/${matches[0]!.name} `;
        setValue(completed);
        setCursor(completed.length);
        return;
      }

      if (key.backspace || key.delete) {
        if (cursor > 0) {
          setValue(value.slice(0, cursor - 1) + value.slice(cursor));
          setCursor(cursor - 1);
        }
        return;
      }

      if (key.leftArrow) {
        setCursor(Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(value.length, cursor + 1));
        return;
      }
      if (key.ctrl && input === 'a') {
        setCursor(0);
        return;
      }
      if (key.ctrl && input === 'e') {
        setCursor(value.length);
        return;
      }
      if (key.ctrl && input === 'u') {
        setValue(value.slice(cursor));
        setCursor(0);
        return;
      }

      if (key.upArrow) {
        if (history.length === 0) return;
        const next = historyIndex === undefined ? 0 : Math.min(history.length - 1, historyIndex + 1);
        setHistoryIndex(next);
        setValue(history[next]!);
        setCursor(history[next]!.length);
        return;
      }
      if (key.downArrow) {
        if (historyIndex === undefined) return;
        if (historyIndex === 0) {
          setHistoryIndex(undefined);
          setValue('');
          setCursor(0);
          return;
        }
        const next = historyIndex - 1;
        setHistoryIndex(next);
        setValue(history[next]!);
        setCursor(history[next]!.length);
        return;
      }

      // Ignore control sequences that reach us as raw input.
      if (key.ctrl || key.meta || key.escape) return;
      if (input) insert(input);

      function insert(text: string) {
        setValue(value.slice(0, cursor) + text + value.slice(cursor));
        setCursor(cursor + text.length);
      }
    },
    { isActive: !disabled },
  );

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={disabled ? theme.dim : theme.accent} paddingX={1}>
        <Text color={disabled ? theme.dim : theme.accent}>{glyphs.prompt} </Text>
        {value.length === 0 ? (
          <Text color={theme.dim}>{placeholder}</Text>
        ) : (
          <Text>
            {value.slice(0, cursor)}
            <Text inverse>{value[cursor] ?? ' '}</Text>
            {value.slice(cursor + 1)}
          </Text>
        )}
      </Box>
      {matches.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {matches.map((c) => (
            <Text key={c.name}>
              <Text color={theme.accent}>/{c.name}</Text>
              <Text color={theme.dim}> — {c.description}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
