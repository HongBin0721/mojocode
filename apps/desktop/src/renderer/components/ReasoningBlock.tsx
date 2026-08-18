/**
 * 思考条目(设计稿:与工具卡同形态的折叠头——brain 图标 + 「已思考 …」+
 * caret)。默认收起,正文点开才摊开——整段思考常驻时间线会淹没真正的回复。
 */

import React, { useState } from 'react';
import { useLocale, t } from '../i18n/index.js';
import { formatDuration } from '../utils/format.js';
import { BrainIcon, CaretDownIcon, CaretUpIcon } from './icons.js';

export function ReasoningBlock({ durationMs, text }: { durationMs?: number; text: string }) {
  useLocale(); // 语言切换时静态文案重算。
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="tool-card reasoning">
      <button type="button" className="tool-row" onClick={() => setExpanded(!expanded)}>
        <span className="tool-icon">
          <BrainIcon size={14} />
        </span>
        <span className="tool-name reasoning-label">
          {durationMs !== undefined
            ? t('reasoning.thought', { duration: formatDuration(durationMs) })
            : t('reasoning.expand')}
        </span>
        <span className="tool-summary" />
        <span className="tool-caret">{expanded ? <CaretUpIcon size={12} /> : <CaretDownIcon size={12} />}</span>
      </button>
      {expanded ? <div className="tool-output reasoning-body">{text}</div> : null}
    </div>
  );
}
