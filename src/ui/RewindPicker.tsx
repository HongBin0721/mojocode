import React, { useState } from 'react';
import { Box, Text, useInput } from './kit.js';
import type { RewindEntry } from '../session/replay.js';
import { theme, glyphs } from './theme.js';
import { t } from '../i18n/index.js';

const WINDOW = 8;

interface Props {
  /** 最新在前(collectRewindEntries 的顺序)。 */
  entries: RewindEntry[];
  onPick: (entry: RewindEntry) => void;
  onCancel: () => void;
}

/**
 * esc-esc 打开的回退选择器。它渲染期间 Input 已卸载(App 的渲染分支互斥),
 * 所以自带的 useInput 不会与输入框抢按键。
 */
export function RewindPicker({ entries, onPick, onCancel }: Props): React.JSX.Element {
  const [cursor, setCursor] = useState(0);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => (c - 1 + entries.length) % entries.length);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % entries.length);
      return;
    }
    if (key.return) {
      const entry = entries[cursor];
      if (entry) onPick(entry);
    }
  });

  const windowStart = Math.max(0, Math.min(cursor - Math.floor(WINDOW / 2), entries.length - WINDOW));
  const visible = entries.slice(windowStart, windowStart + WINDOW);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text bold color={theme.accent}>
          {t('rewind.title')}
        </Text>
        {windowStart > 0 ? (
          <Text color={theme.dim}>{t('selector.moreAbove', { n: windowStart })}</Text>
        ) : null}
        {visible.map((entry, i) => {
          const index = windowStart + i;
          const active = index === cursor;
          return (
            <Text key={entry.index} color={active ? theme.accent : undefined} wrap="truncate-end">
              {active ? `${glyphs.pointer} ` : '  '}
              <Text color={theme.dim}>#{entry.ordinal} </Text>
              {entry.text.replace(/\s+/g, ' ').trim()}
            </Text>
          );
        })}
        {windowStart + WINDOW < entries.length ? (
          <Text color={theme.dim}>
            {t('selector.moreBelow', { n: entries.length - windowStart - WINDOW })}
          </Text>
        ) : null}
      </Box>
      <Box paddingLeft={2}>
        <Text color={theme.dim}>{t('rewind.hint')}</Text>
      </Box>
    </Box>
  );
}
