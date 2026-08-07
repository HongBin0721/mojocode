import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from './kit.js';
import type { SessionMeta } from '../session/store.js';
import { theme, glyphs } from './theme.js';
import { t } from '../i18n/index.js';

const WINDOW = 8;

interface Props {
  sessions: SessionMeta[];
  /** 选中回传会话 id;esc 回传 undefined(调用方开新会话)。 */
  onSelect: (id: string | undefined) => void;
}

/**
 * 启动期的会话选择器:`mojocode -r` 不带参数时先渲染它,选完再进入正式 App。
 * 独立于 Input 的二级选择器——那个由斜杠命令文本触发,这里是启动流程。
 */
export function SessionPicker({ sessions, onSelect }: Props): React.JSX.Element {
  const { exit } = useApp();
  const [cursor, setCursor] = useState(0);

  useInput((_input, key) => {
    if (key.escape) {
      onSelect(undefined);
      exit();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => (c - 1 + sessions.length) % sessions.length);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % sessions.length);
      return;
    }
    if (key.return) {
      onSelect(sessions[cursor]?.id);
      exit();
    }
  });

  const windowStart = Math.max(0, Math.min(cursor - Math.floor(WINDOW / 2), sessions.length - WINDOW));
  const visible = sessions.slice(windowStart, windowStart + WINDOW);

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text bold color={theme.accent}>
          {t('picker.title')}
        </Text>
        {windowStart > 0 ? (
          <Text color={theme.dim}>{t('selector.moreAbove', { n: windowStart })}</Text>
        ) : null}
        {visible.map((meta, i) => {
          const index = windowStart + i;
          const active = index === cursor;
          return (
            <Text key={meta.id} color={active ? theme.accent : undefined} wrap="truncate-end">
              {active ? `${glyphs.pointer} ` : '  '}
              {meta.id.slice(0, 8)}
              <Text color={theme.dim}>
                {'  '}
                {meta.updatedAt.slice(0, 16).replace('T', ' ')}
                {'  '}
                {meta.provider}/{meta.model}
                {'  '}
                {t('cli.msgs', { n: meta.messageCount })}
              </Text>
              {meta.title ? `  ${meta.title}` : ''}
            </Text>
          );
        })}
        {windowStart + WINDOW < sessions.length ? (
          <Text color={theme.dim}>
            {t('selector.moreBelow', { n: sessions.length - windowStart - WINDOW })}
          </Text>
        ) : null}
      </Box>
      <Box paddingLeft={2}>
        <Text color={theme.dim}>{t('picker.hint')}</Text>
      </Box>
    </Box>
  );
}
