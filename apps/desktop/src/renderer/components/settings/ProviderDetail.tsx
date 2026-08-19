/**
 * 右栏:选中供应商的详情与模型 CRUD(自 ModelsSettings.tsx 拆出)。
 * onRemoved:整条删除后由父组件复位选中。key/URL/名称都是失焦或回车提交
 * (ZCode 无显式保存按钮);空值 / 没变 / 不合法时静默丢弃草稿。
 */

import React, { useState } from 'react';
import type { ProviderConfig, ProviderModelEntry } from '@core/schema';
import { PROVIDER_PRESETS, isBuiltinProvider } from '@core/providers';
import { rpcCall } from '../../bridge/invoke.js';
import { useDesktopStore } from '../../state/desktopStore.js';
import { t, useLocale } from '../../i18n/index.js';
import { providerLabel } from '../../utils/model-settings.js';
import { PencilIcon, TrashIcon } from '../icons.js';
import { Field, KeyInput, ApiFormatField } from './fields.js';
import { ModelListEditor } from './ModelListEditor.js';
import type { ModelTestState } from './ModelRow.js';

export function ProviderDetail({ id, onRemoved }: { id: string; onRemoved: () => void }) {
  useLocale();
  const snapshot = useDesktopStore((s) => s.snapshot);
  const [keyDraft, setKeyDraft] = useState('');
  const [urlDraft, setUrlDraft] = useState<string | undefined>();
  const [nameDraft, setNameDraft] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [tests, setTests] = useState<Record<string, ModelTestState>>({});

  const override = snapshot?.config.providers[id];
  const builtin = isBuiltinProvider(id);
  const preset = builtin ? PROVIDER_PRESETS[id as keyof typeof PROVIDER_PRESETS] : undefined;
  const active = snapshot?.provider.id === id;
  const models = override?.models ?? [];
  const hasKey = override?.apiKey !== undefined;
  const baseURL = override?.baseURL ?? preset?.baseURL ?? '';

  // 返回 Promise:ModelListEditor 的弹窗等落盘成功才关(失败留在弹窗,错误
  // 走本组件的 error 区)。
  const save = (config: ProviderConfig, after?: () => void): Promise<void> => {
    setError(undefined);
    return rpcCall({ kind: 'saveProvider', id, config })
      .then(after)
      .catch((err: Error) => {
        setError(err.message);
        throw err;
      });
  };

  const saveModels = (next: ProviderModelEntry[]) => save({ models: next });

  // 不带 model:switchProvider 会走该 provider 自己的默认(override.model ??
  // preset.defaultModel)。硬塞 models[0] 会让「启用」把用户配置的默认模型
  // 换成列表里碰巧排第一的那个。
  const enable = () => {
    setError(undefined);
    void rpcCall({ kind: 'switch', change: { provider: id } }).catch((err: Error) =>
      setError(err.message),
    );
  };

  // 「测试模型」:server 侧向对话端点发一次最小补全;结果(含失败原因)按
  // 模型 id 记成行下胶囊。传输层错误(RPC 断连)同样落到红胶囊,不走 error 区。
  const runTest = (model: string) => {
    setTests((prev) => ({ ...prev, [model]: { state: 'testing' } }));
    void rpcCall({ kind: 'testModel', id, model })
      .then((result) => {
        setTests((prev) => ({
          ...prev,
          [model]: result.ok
            ? { state: 'ok' }
            : { state: 'fail', detail: result.error ?? `HTTP ${result.status ?? '?'}` },
        }));
      })
      .catch((err: Error) =>
        setTests((prev) => ({ ...prev, [model]: { state: 'fail', detail: err.message } })),
      );
  };

  const removeProvider = () => {
    setError(undefined);
    void rpcCall({ kind: 'deleteProvider', id })
      .then(onRemoved)
      .catch((err: Error) => setError(err.message));
  };

  const commitKey = () => {
    const value = keyDraft.trim();
    if (!value) return;
    void save({ apiKey: value }, () => setKeyDraft('')).catch(() => {});
  };
  const commitUrl = () => {
    if (urlDraft === undefined) return;
    const value = urlDraft.trim();
    if (value === baseURL || !/^https?:\/\//.test(value)) {
      setUrlDraft(undefined);
      return;
    }
    void save({ baseURL: value }, () => setUrlDraft(undefined)).catch(() => {});
  };
  const commitName = () => {
    if (nameDraft === undefined) return;
    const value = nameDraft.trim();
    if (!value || value === providerLabel(id, override)) {
      setNameDraft(undefined);
      return;
    }
    void save({ label: value }, () => setNameDraft(undefined)).catch(() => {});
  };

  return (
    <div className="provider-detail">
      <div className="provider-head">
        {nameDraft !== undefined ? (
          <input
            className="setting-input provider-title-input"
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setNameDraft(undefined);
            }}
          />
        ) : (
          <>
            <h2 className="provider-title">{providerLabel(id, override)}</h2>
            {!builtin ? (
              <button
                type="button"
                className="section-icon"
                title={t('settings.rename')}
                onClick={() => setNameDraft(providerLabel(id, override))}
              >
                <PencilIcon size={13} />
              </button>
            ) : null}
          </>
        )}
        {active ? (
          <span className="provider-badge">{t('settings.enabled')}</span>
        ) : (
          <button type="button" className="settings-btn" onClick={enable}>
            {t('settings.enable')}
          </button>
        )}
        {!active && override !== undefined ? (
          <button
            type="button"
            className="settings-btn settings-btn-danger provider-remove"
            title={t('settings.deleteProvider')}
            onClick={removeProvider}
          >
            <TrashIcon size={13} />
          </button>
        ) : null}
      </div>

      <Field label={t('settings.baseURL')}>
        <input
          className="setting-input"
          value={urlDraft ?? baseURL}
          disabled={builtin}
          onChange={(e) => setUrlDraft(e.target.value)}
          onBlur={commitUrl}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      </Field>
      <ApiFormatField />
      <Field label={t('settings.apiKey')}>
        <KeyInput hasKey={hasKey} value={keyDraft} onChange={setKeyDraft} onCommit={commitKey} />
      </Field>

      <div className="field">
        <div className="field-label">{t('settings.modelList')}</div>
        {models.length === 0 ? <div className="settings-group-desc">{t('settings.noModels')}</div> : null}
        <ModelListEditor
          providerId={id}
          models={models}
          currentId={active ? snapshot?.provider.model : undefined}
          tests={tests}
          onTest={runTest}
          onChange={saveModels}
        />
      </div>
      {error ? <div className="settings-error">{error}</div> : null}
    </div>
  );
}
