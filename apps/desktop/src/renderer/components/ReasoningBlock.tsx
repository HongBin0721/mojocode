/**
 * 思考条目:默认只渲染收尾的一行「已思考 8.2s」,正文点开才摊开——
 * 整段思考常驻时间线会淹没真正的回复(TUI 同款取舍)。
 */

import React, { useState } from 'react';
import { useLocale, t } from '../i18n/index.js';
import { formatDuration } from '../utils/format.js';

export function ReasoningBlock({ durationMs, text }: { durationMs?: number; text: string }) {
  useLocale(); // 语言切换时静态文案重算。
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="reasoning">
      <button type="button" className="reasoning-toggle" onClick={() => setExpanded(!expanded)}>
        <span className="reasoning-label">
          {durationMs !== undefined
            ? t('reasoning.thought', { duration: formatDuration(durationMs) })
            : t('reasoning.expand')}
        </span>
        <span className="reasoning-arrow">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded ? <div className="reasoning-body">{text}</div> : null}
    </div>
  );
}
