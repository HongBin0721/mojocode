/**
 * 工作状态行 + 上下文计量:work 镜像(phase/进度/耗时)+ usage(used/window
 * 与本轮增量)。空闲(work === undefined)时那一行隐藏。
 *
 * 扩展的状态行(`/goal` 的「目标 3/10 · 1m04s」)是**独立的一行**,空闲时
 * 照样显示——「目标待续」这类状态恰恰是空闲时更需要看见。它的 `since` 是
 * server 时钟(remote 已校到本地),已用时由客户端自己走秒:扩展只报一次
 * 起点,不必每秒推一帧。与 TUI 的 ExtensionStatusLine 同一套语义。
 */

import React, { useEffect, useState } from 'react';
import { useDesktopStore } from '../state/desktopStore.js';
import { useTimelineStore } from '../state/timelineStore.js';
import { useLocale, t } from '../i18n/index.js';
import { formatElapsed } from '@core/timeline-data';
import { formatContextWindow, formatDuration, formatTokens, percent } from '../utils/format.js';

const PHASE_KEYS = {
  thinking: 'work.thinking',
  responding: 'work.responding',
  tool: 'work.tool',
  compacting: 'work.compacting',
  listingModels: 'work.listingModels',
} as const;

/** 秒表:只在真有带 since 的条目时走,免得空闲界面每秒重渲染。 */
function useSecondTick(active: boolean): void {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
}

function ExtensionStatus() {
  const entries = useDesktopStore((s) => s.snapshot?.extensions?.status);
  useSecondTick(entries?.some((e) => e.since !== undefined) ?? false);
  if (!entries || entries.length === 0) return null;
  const now = Date.now();
  return (
    <div className="status-line status-extensions conv-col">
      {entries.map((entry) => (
        <span key={entry.id} className="status-extension">
          {entry.since === undefined
            ? entry.text
            : `${entry.text} · ${formatElapsed(now - entry.since)}`}
        </span>
      ))}
    </div>
  );
}

export function StatusLine() {
  useLocale();
  const work = useTimelineStore((s) => s.work);
  const usage = useTimelineStore((s) => s.usage);
  const turnTokens = useTimelineStore((s) => s.turnTokens);
  // 耗时每秒走一格——elapsed 不是响应式数据,得自己 tick。
  useSecondTick(work !== undefined);
  if (!work) return <ExtensionStatus />;
  const pct = percent(usage.used, usage.window);

  return (
    <>
      <ExtensionStatus />
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
    </>
  );
}
