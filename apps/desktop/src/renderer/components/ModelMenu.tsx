/**
 * 模型菜单(/models 与 Composer 右下角的模型选择器),ZCode 形态:
 * 当前 provider 的组平铺在顶部(组头 + 模型条目,当前模型 ✓),其他
 * provider 折叠成「label ▸」行,悬停右侧浮出二级;底部「管理模型」
 * 跳设置页·模型设置。列表渲染走通用的 CascadeMenuList。
 *
 * 数据源分两级——设置页·模型设置里配置过模型列表(providers.*.models)时,
 * 直接由快照配置同步构建分组(零探测、零延迟),这是选择器的权威数据;
 * 一个都没配置时回落到 listProviderModels 探测(逐 provider 打 `/models`
 * 端点,死端点最长挂 10s,禁止预热),保持旧行为可用。
 *
 * 选择经 switch 切换(不带 apiKey——GUI 不发凭据,缺 key 时 server 抛错在
 * 此内联显示,菜单只在切换成功后自关)。
 */

import React, { useContext, useEffect, useState } from 'react';
import type { ProviderModelsSummary } from '../../shared/ipc.js';
import { useDesktopStore } from '../state/desktopStore.js';
import { useUiStore } from '../state/uiStore.js';
import { t, useLocale } from '../i18n/index.js';
import { configuredModelGroups } from '../utils/model-settings.js';
import { CascadeMenuList, type CascadeItem, type CascadeSection } from './CascadeMenu.js';
import { MenuCloseContext } from './Menu.js';

export function ModelMenuList() {
  useLocale();
  const snapshot = useDesktopStore((s) => s.snapshot);
  const openSettings = useUiStore((s) => s.openSettings);
  const closeMenu = useContext(MenuCloseContext);
  const [probed, setProbed] = useState<ProviderModelsSummary[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  // 配置直读优先:设置页维护的模型列表就是选择器要显示的内容;当前模型
  // 一并传入,激活 provider 没配列表时兜出它自己的组。
  const configured = configuredModelGroups(
    snapshot?.config,
    snapshot?.provider.id,
    snapshot?.provider.model,
  );
  const needsProbe = configured === undefined;

  useEffect(() => {
    // 仅在没有任何配置列表时探测,且仅挂载时请求一次(菜单关闭即卸载)——
    // listProviderModels 在 server 的串行队列上逐厂商探测,最坏要等最慢的
    // 死端点,不能预热也不能反复刷。
    if (!needsProbe) return;
    let cancelled = false;
    void window.mojocode
      .rpc({ kind: 'listProviderModels' })
      .then((result) => {
        if (!cancelled) setProbed(result as ProviderModelsSummary[]);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [needsProbe]);

  const pick = (providerId: string, model: string) => {
    void window.mojocode
      .rpc({ kind: 'switch', change: { provider: providerId, model } })
      .then(() => closeMenu())
      .catch((err: Error) => setError(err.message));
  };

  const models = configured ?? probed;
  if (error) return <div className="menu-error">{error}</div>;
  if (!models) return <div className="menu-loading">{t('modelMenu.loading')}</div>;

  // 条目只显示模型 id(ZCode 形态,不带上下文窗口标注——那是设置页的信息)。
  const items = (group: ProviderModelsSummary): CascadeItem[] =>
    group.models.map((model) => ({
      id: model.id,
      label: model.id,
      current: snapshot?.provider.id === group.providerId && snapshot?.provider.model === model.id,
    }));

  // 当前 provider 的组平铺(找不到时取第一组),其余折叠成悬停二级。
  const primary = models.find((g) => g.providerId === snapshot?.provider.id) ?? models[0];
  const sections: CascadeSection[] = models.map((group) =>
    group === primary
      ? { kind: 'inline', id: group.providerId, label: group.label, error: group.error, items: items(group) }
      : { kind: 'submenu', id: group.providerId, label: group.label, error: group.error, items: items(group) },
  );

  return (
    <CascadeMenuList
      sections={sections}
      footer={{
        label: t('modelMenu.manage'),
        onClick: () => {
          closeMenu();
          openSettings('models');
        },
      }}
      onPick={pick}
    />
  );
}
