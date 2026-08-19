/**
 * 添加供应商表单(自 ModelsSettings.tsx 拆出;右栏整体替换,对齐 ZCode):
 * 名称 + Base URL + API Key + API 格式 + 初始模型列表,一次 saveProvider
 * 落盘。配置键由名称派生(deriveProviderId)。列表块走 ModelListEditor;
 * 本地条目还没落盘,不传 providerId(能力查询回退到全库按模型名撞)、
 * 不提供测试。
 */

import React, { useState } from 'react';
import type { ProviderConfig, ProviderModelEntry } from '@core/schema';
import { rpcCall } from '../../bridge/invoke.js';
import { useDesktopStore } from '../../state/desktopStore.js';
import { t, useLocale } from '../../i18n/index.js';
import { deriveProviderId } from '../../utils/model-settings.js';
import { Field, KeyInput, ApiFormatField } from './fields.js';
import { ModelListEditor } from './ModelListEditor.js';

export function AddProviderForm({ onDone }: { onDone: (id: string) => void }) {
  useLocale();
  const config = useDesktopStore((s) => s.snapshot?.config);
  const [name, setName] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ProviderModelEntry[]>([]);
  const [error, setError] = useState<string | undefined>();
  const validUrl = /^https?:\/\//.test(baseURL.trim());
  const submit = () => {
    const id = deriveProviderId(name, config);
    const patch: ProviderConfig = {
      label: name.trim(),
      baseURL: baseURL.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(models.length > 0 ? { models } : {}),
    };
    void rpcCall({ kind: 'saveProvider', id, config: patch })
      .then(() => onDone(id))
      .catch((err: Error) => setError(err.message));
  };
  return (
    <div className="provider-detail">
      <div className="provider-head">
        <h2 className="provider-title">{t('settings.addProviderTitle')}</h2>
      </div>
      <div className="provider-desc">{t('settings.addProviderDesc')}</div>
      <Field label={t('settings.name')}>
        <input
          className="setting-input"
          autoFocus
          value={name}
          placeholder={t('settings.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label={t('settings.baseURL')}>
        <input
          className="setting-input"
          value={baseURL}
          placeholder="https://api.example.com/v1"
          onChange={(e) => setBaseURL(e.target.value)}
        />
      </Field>
      <Field label={t('settings.apiKey')}>
        <KeyInput hasKey={false} value={apiKey} onChange={setApiKey} onCommit={() => {}} />
      </Field>
      <ApiFormatField />
      <div className="field">
        <div className="field-label">{t('settings.modelList')}</div>
        <ModelListEditor models={models} onChange={setModels} />
      </div>
      {error ? <div className="settings-error">{error}</div> : null}
      <div className="settings-actions">
        <button
          type="button"
          className="settings-btn settings-btn-primary"
          disabled={!name.trim() || !validUrl}
          onClick={submit}
        >
          {t('settings.addProvider')}
        </button>
      </div>
    </div>
  );
}
