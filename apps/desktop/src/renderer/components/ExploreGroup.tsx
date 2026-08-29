/**
 * 探索聚合卡:一段连续的只读工具(+ 穿插思考)合成一条,收起时只有一行
 * 摘要(读取 N 个文件 · 检索 M 次 · 思考 x s),展开逐条渲染原工具卡/思考
 * 块——信息不丢,只是默认不占屏。
 */

import React, { useState } from 'react';
import { useLocale, t } from '../i18n/index.js';
import { formatDuration } from '../utils/format.js';
import type { ExploreEntry } from '../utils/timeline-groups.js';
import { TimelineItemView } from './TimelineItemView.js';
import { DURATION_SHOW_MS } from './ToolCard.js';
import { CaretDownIcon, CaretUpIcon, MagnifyingGlassIcon } from './icons.js';

export function ExploreGroup({ entry }: { entry: ExploreEntry }) {
  useLocale();
  const [expanded, setExpanded] = useState(false);
  const parts: string[] = [];
  if (entry.reads > 0) parts.push(t('explore.reads', { count: entry.reads }));
  if (entry.searches > 0) parts.push(t('explore.searches', { count: entry.searches }));
  if (entry.web > 0) parts.push(t('explore.web', { count: entry.web }));
  if (entry.thoughtMs > 0)
    parts.push(t('reasoning.chip', { duration: formatDuration(entry.thoughtMs) }));

  return (
    <div className="tool-card">
      <button type="button" className="tool-row" onClick={() => setExpanded(!expanded)}>
        <span className="tool-icon">
          <MagnifyingGlassIcon size={14} />
        </span>
        <span className="tool-name">{t('explore.title')}</span>
        <span className="tool-summary">{parts.join(' · ')}</span>
        {entry.durationMs > DURATION_SHOW_MS ? (
          <span className="tool-duration">{formatDuration(entry.durationMs)}</span>
        ) : null}
        <span className="tool-caret">
          {expanded ? <CaretUpIcon size={12} /> : <CaretDownIcon size={12} />}
        </span>
      </button>
      {expanded ? (
        <div className="explore-steps">
          {entry.steps.map((step) => (
            <TimelineItemView key={step.key} item={step} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
