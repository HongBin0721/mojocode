import { createMemo, createSignal, For, Show } from 'solid-js';
import { Box, Text, useInput, type JSX } from './kit.js';
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
export function RewindPicker(props: Props): JSX.Element {
  const [cursor, setCursor] = createSignal(0);

  useInput((_input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => (c - 1 + props.entries.length) % props.entries.length);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % props.entries.length);
      return;
    }
    if (key.return) {
      const entry = props.entries[cursor()];
      if (entry) props.onPick(entry);
    }
  });

  const windowStart = createMemo(() =>
    Math.max(0, Math.min(cursor() - Math.floor(WINDOW / 2), props.entries.length - WINDOW)),
  );
  const visible = createMemo(() => props.entries.slice(windowStart(), windowStart() + WINDOW));

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text bold color={theme.accent}>
          {t('rewind.title')}
        </Text>
        <Show when={windowStart() > 0}>
          <Text color={theme.dim}>{t('selector.moreAbove', { n: windowStart() })}</Text>
        </Show>
        <For each={visible()}>
          {(entry, i) => {
            const active = () => windowStart() + i() === cursor();
            return (
              <Text color={active() ? theme.accent : undefined} wrap="truncate-end">
                {active() ? `${glyphs.pointer} ` : '  '}
                <Text color={theme.dim}>#{entry.ordinal} </Text>
                {entry.text.replace(/\s+/g, ' ').trim()}
              </Text>
            );
          }}
        </For>
        <Show when={windowStart() + WINDOW < props.entries.length}>
          <Text color={theme.dim}>
            {t('selector.moreBelow', { n: props.entries.length - windowStart() - WINDOW })}
          </Text>
        </Show>
      </Box>
      <Box paddingLeft={2}>
        <Text color={theme.dim}>{t('rewind.hint')}</Text>
      </Box>
    </Box>
  );
}
