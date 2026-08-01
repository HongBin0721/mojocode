import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Diff } from './Diff.js';
import { theme, glyphs } from './theme.js';
import type { PermissionDecision, PermissionRequest } from '../core/events.js';
import { t } from '../i18n/index.js';

interface Props {
  request: PermissionRequest;
  onDecide: (decision: PermissionDecision) => void;
}

interface Option {
  label: string;
  /** 选项后面淡色展示的补充说明(建议的规则等)。 */
  note?: string;
  decision: PermissionDecision;
  danger?: boolean;
}

/**
 * 授权确认:上下键 + 回车的选项列表(主流 CLI 的交互习惯),数字键直达,
 * esc 拒绝。y/n 作为老习惯的快捷键保留。
 */
export function PermissionPrompt({ request, onDecide }: Props): React.ReactElement {
  const [cursor, setCursor] = useState(0);

  const options: Option[] = [
    { label: t('perm.allowOnce'), decision: { type: 'allow' } },
    ...(request.suggestedRule
      ? ([
          {
            label: t('perm.alwaysSession'),
            note: request.suggestedRule,
            decision: { type: 'allow-always', rule: request.suggestedRule },
          },
          {
            label: t('perm.alwaysPersist'),
            note: request.suggestedRule,
            decision: { type: 'allow-persist', rule: request.suggestedRule },
          },
        ] satisfies Option[])
      : []),
    { label: t('perm.deny'), decision: { type: 'deny' }, danger: true },
  ];

  // 换成另一个请求时组件并不卸载(只有 permission 变 undefined 才卸载),
  // cursor 会跨请求残留下来。
  useEffect(() => setCursor(0), [request.id]);

  // 复位要等这一帧渲染完才生效,所以读取一律走钳制后的下标:上一个请求有
  // 4 个选项、光标停在第 4 项,下一个请求只有 2 个选项时,回车会读到
  // undefined 并让整个 TUI 崩掉。
  const selected = Math.min(cursor, options.length - 1);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => (c + options.length - 1) % options.length);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % options.length);
      return;
    }
    if (key.return) {
      onDecide(options[selected]!.decision);
      return;
    }
    if (key.escape) {
      onDecide({ type: 'deny' });
      return;
    }
    // 数字键直达对应选项。必须限定单字符:粘贴会作为一整个 input 到达,
    // parseInt 只取首位数字,"3 files changed…" 会被当成按下 3 而误选。
    if (/^[1-9]$/.test(input)) {
      const digit = Number(input);
      if (digit <= options.length) {
        onDecide(options[digit - 1]!.decision);
        return;
      }
    }
    // 老习惯的快捷键。
    if (input.toLowerCase() === 'y') onDecide({ type: 'allow' });
    else if (input.toLowerCase() === 'n') onDecide({ type: 'deny' });
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
        {options.map((option, index) => {
          const active = index === selected;
          const color = option.danger ? theme.error : active ? theme.accent : undefined;
          return (
            <Text key={option.label} color={active ? color ?? theme.accent : undefined}>
              {active ? `${glyphs.pointer} ` : '  '}
              <Text color={theme.dim}>{index + 1}.</Text>{' '}
              <Text color={color} bold={active}>
                {option.label}
              </Text>
              {option.note ? <Text color={theme.dim}> ({option.note})</Text> : null}
            </Text>
          );
        })}
        <Box marginTop={1}>
          <Text color={theme.dim}>{t('perm.hint')}</Text>
        </Box>
      </Box>
    </Box>
  );
}

function clamp(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join('\n')}\n${t('ui.moreLines', { n: lines.length - maxLines })}`;
}
