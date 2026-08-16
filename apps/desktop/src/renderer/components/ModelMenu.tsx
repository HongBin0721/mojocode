/**
 * 模型菜单(/models):打开时才请求 listProviderModels(逐 provider 探测,
 * 死端点最长挂 10s,禁止预热),分组列表 + 当前项标记;选择经 switch 切换
 * (不带 apiKey——GUI 不发凭据,缺 key 时 server 抛错在此内联显示)。
 */

import React, { useEffect, useState } from 'react';
import type { ProviderModelsSummary } from '../../shared/ipc.js';
import { useDesktopStore } from '../state/desktopStore.js';
import { t, useLocale } from '../i18n/index.js';
import { formatTokens } from '../utils/format.js';

/** contextWindows 的模型 id → 窗口大小映射的标注(缺省无)。 */
function contextNote(list: ProviderModelsSummary, id: string): string | undefined {
  const window = list.contextWindows?.[id];
  return window ? formatTokens(window) : undefined;
}

export function ModelMenuList() {
  useLocale();
  const snapshot = useDesktopStore((s) => s.snapshot);
  const [models, setModels] = useState<ProviderModelsSummary[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    // 仅挂载时请求一次(菜单关闭即卸载)——listProviderModels 在 server 的
    // 串行队列上逐厂商探测,最坏要等最慢的死端点,不能预热也不能反复刷。
    let cancelled = false;
    void window.mojocode
      .rpc({ kind: 'listProviderModels' })
      .then((result) => {
        if (!cancelled) setModels(result as ProviderModelsSummary[]);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pick = (providerId: string, model: string) => {
    void window.mojocode
      .rpc({ kind: 'switch', change: { provider: providerId, model } })
      .catch((err: Error) => setError(err.message));
  };

  if (error) return <div className="menu-error">{error}</div>;
  if (!models) return <div className="menu-loading">{t('modelMenu.loading')}</div>;

  return (
    <div className="model-menu">
      {models.map((group) => (
        <div key={group.providerId} className="model-group">
          <div className="model-group-label">{group.label}</div>
          {group.error ? <div className="menu-error">{group.error}</div> : null}
          {group.models.map((model) => {
            const current =
              snapshot?.provider.id === group.providerId && snapshot?.provider.model === model.id;
            const note = contextNote(group, model.id);
            return (
              <button
                type="button"
                key={model.id}
                className={`menu-item ${current ? 'menu-item-current' : ''}`}
                onClick={() => pick(group.providerId, model.id)}
              >
                <span className="menu-item-label">{model.id}</span>
                {note ? <span className="menu-item-note">{note}</span> : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
