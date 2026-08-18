/**
 * 工作状态行 + 上下文计量:work 镜像(phase/进度/耗时)+ usage(used/window
 * 与本轮增量)。空闲(work === undefined)时整行隐藏。
 */

import React, { useEffect, useState } from 'react';
import { useTimelineStore } from '../state/timelineStore.js';
import { useLocale, t } from '../i18n/index.js';
import { formatContextWindow, formatDuration, formatTokens, percent } from '../utils/format.js';

const PHASE_KEYS = {
  thinking: 'work.thinking',
  responding: 'work.responding',
  evaluating: 'work.evaluating',
  tool: 'work.tool',
  waiting: 'work.waiting',
  compacting: 'work.compacting',
  listingModels: 'work.listingModels',
} as const;

export function StatusLine() {
  useLocale();
  const work = useTimelineStore((s) => s.work);
  const usage = useTimelineStore((s) => s.usage);
  const turnTokens = useTimelineStore((s) => s.turnTokens);
  // 耗时每秒走一格——elapsed 不是响应式数据,得自己 tick。
  const [, tick] = useState(0);
  useEffect(() => {
    if (!work) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [work?.since, work?.phase, work]);
  if (!work) return null;

  const pct = percent(usage.used, usage.window);

  return (
    <div className="status-line conv-col">
      <span className={`work work-${work.phase}`}>
        {t(PHASE_KEYS[work.phase])}
        {work.detail ? ` · ${work.detail}` : ''}
        {work.progress !== undefined ? ` ${Math.round(work.progress * 100)}%` : ''}
      </span>
      <span className="status-elapsed">{formatDuration(Date.now() - work.since)}</span>
      <span className="status-right">
        {turnTokens > 0 ? <span>+{formatTokens(turnTokens)} </span> : null}
        {/* 上下文用量:设计稿语言的 mono 胶囊(41K / 128K · 32%),不是 TUI 的 ▰▱ 条 */}
        {usage.window > 0 ? (
          <span className="status-ctx">
            {formatContextWindow(usage.used)} / {formatContextWindow(usage.window)} · {pct}%
          </span>
        ) : null}
      </span>
    </div>
  );
}
