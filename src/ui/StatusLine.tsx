import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { theme, toolDisplayName } from './theme.js';
import { t, type MessageKey } from '../i18n/index.js';

/** 工作阶段。undefined(空闲)时整行不渲染,由 App 控制。 */
export type WorkPhase =
  | 'thinking'
  | 'responding'
  | 'tool'
  | 'waiting'
  | 'compacting'
  | 'listingModels';

export interface WorkState {
  phase: WorkPhase;
  /** 附加信息(目前只有工具名)。 */
  detail?: string;
  /** 本轮工作的起始时刻,用于显示已用时。 */
  since: number;
}

interface Props extends WorkState {
  /** 有任务清单时在提示里加上 ctrl+t 开关说明;undefined 表示没有清单。 */
  todoHint?: 'show' | 'hide';
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const FRAME_MS = 100;

/** 不同阶段用不同颜色,一眼区分在想、在答、在跑工具还是在等人。 */
const PHASE_COLORS: Record<WorkPhase, string> = {
  thinking: 'magenta',
  responding: theme.accent,
  tool: theme.tool,
  waiting: theme.warn,
  compacting: theme.accent,
  listingModels: theme.accent,
};

const PHASE_LABELS: Record<Exclude<WorkPhase, 'tool'>, MessageKey> = {
  thinking: 'status.thinking',
  responding: 'status.responding',
  waiting: 'status.waiting',
  compacting: 'status.compacting',
  listingModels: 'status.listingModels',
};

/**
 * 输入框上方的工作状态行:动画 spinner + 阶段文字 + 已用时 + esc 提示,
 * 与主流 CLI(Claude Code / Codex)的布局一致。定时器同时驱动 spinner
 * 帧和秒数刷新,组件卸载(回到空闲)即停止。
 */
export function StatusLine({ phase, detail, since, todoHint }: Props): React.ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), FRAME_MS);
    return () => clearInterval(timer);
  }, []);

  const frame = FRAMES[Math.floor(now / FRAME_MS) % FRAMES.length]!;
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const color = PHASE_COLORS[phase];
  const label =
    phase === 'tool'
      ? t('status.runningTool', { tool: toolDisplayName(detail ?? '') })
      : t(PHASE_LABELS[phase]);

  const extra = todoHint
    ? ` · ${t(todoHint === 'hide' ? 'status.todoHide' : 'status.todoShow')}`
    : '';

  return (
    <Box marginTop={1}>
      <Text color={color}>{frame} </Text>
      <Text color={color} bold>
        {label}
      </Text>
      <Text color={theme.dim}> {t('status.meta', { s: seconds, extra })}</Text>
    </Box>
  );
}
