/**
 * 全屏设置页(ZCode 形态):替换整个工作区,自带左侧栏——顶部「← 返回
 * 工作区」,「基础设置」组下三节:常规 / 外观 / 模型设置。Esc 同样返回。
 *
 * 常规:语言(原侧栏设置菜单的 toggle 移入,改为单选)。
 * 外观:界面主题(目前仅深色,禁用项如实呈现)+ 界面字号(localStorage
 *   持久化,改 `--ui-font-size` token 即时生效)。
 * 模型设置:ModelsSettings.tsx(供应商与模型列表管理)。
 */

import React, { useEffect } from 'react';
import { t, useLocale, setLocale, getLocale, type Locale } from '../i18n/index.js';
import { useUiStore, type SettingsSection } from '../state/uiStore.js';
import {
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
  applyUiFontSize,
  clampUiFontSize,
  loadUiFontSize,
  saveUiFontSize,
} from '../utils/appearance.js';
import { ModelsSettings } from './ModelsSettings.js';
import { Select } from './Select.js';
import { ArrowLeftIcon, LayersIcon, MoonIcon, PaletteIcon, SlidersIcon } from './icons.js';

/** 设置行:左侧标题+说明,右侧控件(ZCode 的卡片行布局)。 */
export function SettingRow({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-row-text">
        <div className="setting-row-label">{label}</div>
        {desc ? <div className="setting-row-desc">{desc}</div> : null}
      </div>
      <div className="setting-row-control">{children}</div>
    </div>
  );
}

function GeneralSection() {
  useLocale();
  const locale = getLocale();
  return (
    <>
      <h1 className="settings-h1">{t('settings.general')}</h1>
      <div className="settings-card">
        <SettingRow label={t('settings.language')} desc={t('settings.languageDesc')}>
          <Select
            value={locale}
            ariaLabel={t('settings.language')}
            options={[
              { value: 'zh-CN', label: t('settings.langZh') },
              { value: 'en', label: t('settings.langEn') },
            ]}
            onChange={(next) => setLocale(next as Locale)}
          />
        </SettingRow>
      </div>
    </>
  );
}

function AppearanceSection() {
  useLocale();
  const [fontSize, setFontSize] = React.useState(loadUiFontSize);
  const commitFontSize = (value: number) => {
    const next = clampUiFontSize(value);
    setFontSize(next);
    applyUiFontSize(next);
    saveUiFontSize(next);
  };
  return (
    <>
      <h1 className="settings-h1">{t('settings.appearance')}</h1>
      <div className="settings-group-head">
        <div className="settings-group-title">{t('settings.uiGroup')}</div>
        <div className="settings-group-desc">{t('settings.uiGroupDesc')}</div>
      </div>
      <div className="settings-card">
        <SettingRow label={t('settings.theme')} desc={t('settings.themeDesc')}>
          <Select
            value="dark"
            disabled
            ariaLabel={t('settings.theme')}
            options={[{ value: 'dark', label: t('settings.themeDark'), icon: <MoonIcon size={13} /> }]}
          />
        </SettingRow>
        <SettingRow label={t('settings.fontSize')} desc={t('settings.fontSizeDesc')}>
          <span className="setting-number">
            <input
              type="number"
              min={UI_FONT_SIZE_MIN}
              max={UI_FONT_SIZE_MAX}
              value={fontSize}
              onChange={(e) => commitFontSize(Number(e.target.value))}
            />
            px
          </span>
        </SettingRow>
      </div>
    </>
  );
}

const SECTIONS = [
  { id: 'general', icon: <SlidersIcon size={15} />, label: 'settings.general' },
  { id: 'appearance', icon: <PaletteIcon size={15} />, label: 'settings.appearance' },
  { id: 'models', icon: <LayersIcon size={15} />, label: 'settings.models' },
] as const satisfies ReadonlyArray<{ id: SettingsSection; icon: React.ReactNode; label: string }>;

export function SettingsPage() {
  useLocale();
  const section = useUiStore((s) => s.settingsSection);
  const setSection = useUiStore((s) => s.setSettingsSection);
  const closeSettings = useUiStore((s) => s.closeSettings);

  // Esc 返回工作区(与 ZCode 一致);输入控件聚焦时不劫持。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      closeSettings();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeSettings]);

  return (
    <div className="settings-shell">
      <aside className="settings-sidebar">
        {/* 顶条是窗口拖拽区,mac 红绿灯让位由平台类控制(同 .sidebar-top)。 */}
        <div className="settings-side-top" />
        <button type="button" className="settings-back" onClick={closeSettings}>
          <ArrowLeftIcon size={15} />
          {t('settings.back')}
        </button>
        <div className="settings-nav-group">{t('settings.groupBasic')}</div>
        {SECTIONS.map(({ id, icon, label }) => (
          <button
            type="button"
            key={id}
            className={`settings-nav ${section === id ? 'settings-nav-active' : ''}`}
            onClick={() => setSection(id)}
          >
            <span className="side-nav-icon">{icon}</span>
            {t(label)}
          </button>
        ))}
      </aside>
      <main className="settings-main">
        {/* 主区顶部窄条:让设置页保留一段可拖拽窗口的区域。 */}
        <div className="settings-main-drag" />
        <div className="settings-content">
          {section === 'general' ? (
            <GeneralSection />
          ) : section === 'appearance' ? (
            <AppearanceSection />
          ) : (
            <ModelsSettings />
          )}
        </div>
      </main>
    </div>
  );
}
