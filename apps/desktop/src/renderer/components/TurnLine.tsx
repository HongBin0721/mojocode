/**
 * 一轮的收尾行:模型 · 耗时 · 本轮 token(含缓存命中段)。中断/出错的轮
 * 不落这条(reducer 里各走 aborted/error 分支)。
 */

import React from 'react';
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
  const cacheNote =
    cachedTokens !== undefined && inputTokens ? ` · ${percent(cachedTokens, inputTokens)}% cache` : '';
  return (
    <div className="turn-line">
      {model} · {formatDuration(durationMs)} · {formatTokens(tokens)} tokens{cacheNote}
    </div>
  );
}
