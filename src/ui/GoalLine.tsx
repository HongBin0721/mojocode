import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { theme, glyphs, truncateWidth, WIDTH_SAFETY } from './theme.js';
import { t } from '../i18n/index.js';
import type { GoalStatus } from '../agent/goal.js';

interface Props {
  /**
   * 现取快照,而不是收一份 props 里的值:轮数和已用时一直在变,而目标循环
   * 期间 App 未必会重新渲染(两轮之间只有 bus 事件,中间那几十秒里没有任何
   * state 变化)。这个组件自己按秒 tick,每次现读。
   */
  snapshot: () => GoalStatus | undefined;
  /** 终端宽度,用于截断——理由见下方注释。 */
  columns: number;
}

/**
 * 输入框正上方靠右的一行目标进度:`◎ 目标 3/10 · 1m04s`。
 *
 * 单独占一行而不是挤进 StatusLine,有两个原因:StatusLine 只在有工作状态时
 * 渲染,而恢复回来的目标是"已设定但没在跑",那时更需要提醒;而且状态行本身
 * 已经带了阶段、秒数和 esc 提示,窄终端下再往里塞就要折行了。
 */
export function GoalLine({ snapshot, columns }: Props): React.ReactElement | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const status = snapshot();
  if (!status) return null;

  const label = status.restored
    ? t('goal.pending')
    : t('goal.progress', {
        turn: status.turns,
        max: status.maxTurns,
        elapsed: formatElapsed(status.elapsedMs),
      });

  return (
    <Box justifyContent="flex-end" paddingRight={WIDTH_SAFETY}>
      {/* 必须截断:待续那句英文有 40 多列,窄终端下会折成两行,而 App 的
          高度预算只给这里留了一行,动态区就会比记账多出一行。 */}
      <Text color={theme.dim}>
        {truncateWidth(`${glyphs.goal} ${label}`, Math.max(8, columns - WIDTH_SAFETY))}
      </Text>
    </Box>
  );
}

/**
 * 走时用的时长:整秒,不带小数。theme 的 formatDuration 是给工具耗时用的,
 * 一分钟以内带一位小数(`4.2s`)——挂在这里每秒跳一次尾数只是噪音。
 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}
