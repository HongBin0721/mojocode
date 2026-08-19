/**
 * 上下文环(自 Composer.tsx 拆出;设计稿):28px 悬停区里一个 15px
 * conic-gradient 圆环(已用扇区亮色 #cfd3e5、剩余 #3f424d,9px 内孔挖回
 * 输入框底色),悬停出三行 tooltip。数据:快照的权威 contextUsage(provider
 * 上报/换史后估算);首轮之前回退当前模型的窗口标称值(0 已用)。
 */

import React, { useState } from 'react';
import { useDesktopStore } from '../../state/desktopStore.js';
import { t, useLocale } from '../../i18n/index.js';
import { formatContextWindow, formatTokens, percent } from '../../utils/format.js';

export function ContextRing() {
  useLocale();
  const reportedUsage = useDesktopStore((s) => s.snapshot?.agent.contextUsage);
  const providerWindow = useDesktopStore((s) => s.snapshot?.provider.contextWindow);
  const [tipOpen, setTipOpen] = useState(false);
  const usage = reportedUsage ?? (providerWindow ? { used: 0, window: providerWindow } : undefined);
  if (!usage || usage.window <= 0) return null;

  const pct = percent(usage.used, usage.window);
  return (
    <div
      className="ctx-ring-wrap"
      onMouseEnter={() => setTipOpen(true)}
      onMouseLeave={() => setTipOpen(false)}
    >
      <div
        className="ctx-ring"
        style={{ background: `conic-gradient(#cfd3e5 0 ${pct}%, #3f424d ${pct}% 100%)` }}
      >
        <div className="ctx-ring-hole" />
      </div>
      {tipOpen ? (
        <div className="ctx-tip">
          <div className="ctx-tip-title">{t('composer.ctxTitle')}</div>
          <div className="ctx-tip-line">
            {t('composer.ctxUsedPct', { pct: String(pct), left: String(100 - pct) })}
          </div>
          <div className="ctx-tip-sub">
            {t('composer.ctxTokens', {
              used: formatTokens(usage.used),
              total: formatContextWindow(usage.window),
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
