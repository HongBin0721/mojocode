/**
 * 一轮的收尾行:模型 · 耗时 · 本轮 token(含缓存命中段)。中断/出错的轮
 * 不落这条(reducer 里各走 aborted/error 分支)。
 */

import React from 'react';
import { useLocale, t } from '../i18n/index.js';
import { formatDuration, formatTokens, percent } from '../utils/format.js';

export function TurnLine({
  model,
  durationMs,
  tokens,
  inputTokens,
  cachedTokens,
}: {
  model: string;
  durationMs: number;
  tokens: number;
  inputTokens?: number;
  cachedTokens?: number;
}) {
  useLocale(); // 语言切换时缓存段文案重算。
  const cacheNote =
    cachedTokens !== undefined && inputTokens
      ? t('turn.cacheHit', { percent: percent(cachedTokens, inputTokens) })
      : '';
  return (
    <div className="turn-line">
      {model} · {formatDuration(durationMs)} · {formatTokens(tokens)} tokens{cacheNote}
    </div>
  );
}
