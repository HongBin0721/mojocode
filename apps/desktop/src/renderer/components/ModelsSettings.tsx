/**
 * 设置页·模型设置(ZCode 形态的双栏卡片)——页面本体:左列供应商列表
 * (预设/自定义两组 + 添加入口),右栏按选中态分发到 settings/ 子目录的
 * ProviderDetail 或 AddProviderForm。表单原子/模型弹窗/模型列表编辑块也
 * 都在 settings/ 下(fields.tsx / ModelModal.tsx / ModelListEditor.tsx)。
 *
 * 所有写操作走 saveProvider/deleteProvider RPC——server 侧合并内存配置并
 * 落盘 `~/.mojocode/config.json`,变更后的脱敏快照经 state 推送回流,本组件
 * 不维护镜像副本(输入草稿除外)。Composer 的模型选择器直接消费这里配置的
 * models 列表(utils/model-settings.ts 的 configuredModelGroups)。
 */

import React, { useState } from 'react';
import { useDesktopStore } from '../state/desktopStore.js';
import { t, useLocale } from '../i18n/index.js';
import { providerList } from '../utils/model-settings.js';
import { PlusIcon } from './icons.js';
import { AddProviderForm } from './settings/AddProviderForm.js';
import { ProviderDetail } from './settings/ProviderDetail.js';

export function ModelsSettings() {
  useLocale();
  const config = useDesktopStore((s) => s.snapshot?.config);
  const currentId = useDesktopStore((s) => s.snapshot?.provider.id);
  const [selected, setSelected] = useState<string | undefined>();
  const [adding, setAdding] = useState(false);

  const { presets, custom } = providerList(config, currentId);
  const selectedId = selected ?? currentId ?? presets[0]?.id;

  const row = (item: { id: string; label: string; configured: boolean }) => (
    <button
      type="button"
      key={item.id}
      className={`provider-row ${!adding && item.id === selectedId ? 'provider-row-active' : ''}`}
      onClick={() => {
        setAdding(false);
        setSelected(item.id);
      }}
    >
      <span className="provider-row-label">{item.label}</span>
      {item.configured ? <span className="provider-dot" /> : null}
    </button>
  );

  return (
    <>
      <h1 className="settings-h1">{t('settings.models')}</h1>
      <div className="settings-group-head">
        <div className="settings-group-desc">{t('settings.modelsDesc')}</div>
      </div>
      <div className="models-panel">
        <div className="models-side">
          <div className="models-side-group">{t('settings.presetProviders')}</div>
          {presets.map(row)}
          <div className="models-side-group">{t('settings.customProviders')}</div>
          {custom.map(row)}
          <button
            type="button"
            className={`provider-row provider-row-add ${adding ? 'provider-row-active' : ''}`}
            onClick={() => setAdding(true)}
          >
            <PlusIcon size={13} />
            {t('settings.addProvider')}
          </button>
        </div>
        <div className="models-detail">
          {adding ? (
            <AddProviderForm
              onDone={(id) => {
                setAdding(false);
                setSelected(id);
              }}
            />
          ) : selectedId ? (
            <ProviderDetail key={selectedId} id={selectedId} onRemoved={() => setSelected(undefined)} />
          ) : null}
        </div>
      </div>
    </>
  );
}
