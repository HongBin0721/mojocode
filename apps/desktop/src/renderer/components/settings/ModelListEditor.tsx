/**
 * 模型列表编辑块(.model-rows + 添加按钮 + ModelModal 接线):此前在
 * AddProviderForm 与 ProviderDetail 里逐行重复的唯一合并点。弹窗开关态归
 * 本组件;onChange 返回 Promise 时(落盘路径)等成功才关弹窗——失败时
 * 弹窗留着,错误由调用方的 error 区展示,与拆分前 ProviderDetail 的
 * `save(…, () => setModal(undefined))` 语义一致。
 */

import React, { useState } from 'react';
import type { ProviderModelEntry } from '@core/schema';
import { t } from '../../i18n/index.js';
import { upsertModel } from '../../utils/model-settings.js';
import { PlusIcon } from '../icons.js';
import { ModelModal } from './ModelModal.js';
import { ModelRow, type ModelTestState } from './ModelRow.js';

export function ModelListEditor({
  providerId,
  models,
  currentId,
  tests,
  onTest,
  onChange,
}: {
  /** 已落盘条目才有(供 ModelModal 的能力目录预设映射);添加表单里缺省。 */
  providerId?: string;
  models: ProviderModelEntry[];
  /** 激活 provider 的当前模型 id(行高亮);非激活 provider 缺省。 */
  currentId?: string;
  tests?: Record<string, ModelTestState>;
  onTest?: (model: string) => void;
  /** 列表变更(增/改/删)。返回 Promise 时弹窗等成功才关。 */
  onChange: (next: ProviderModelEntry[]) => void | Promise<void>;
}) {
  const [modal, setModal] = useState<number | 'new' | undefined>();

  const commit = (next: ProviderModelEntry[]) => {
    const result = onChange(next);
    if (result instanceof Promise) {
      result.then(() => setModal(undefined)).catch(() => {});
    } else {
      setModal(undefined);
    }
  };

  return (
    <>
      <div className="model-rows">
        {models.map((model, index) => (
          <ModelRow
            key={`${index}-${model.id}`}
            model={model}
            current={currentId !== undefined && currentId === model.id}
            test={tests?.[model.id]}
            onTest={onTest ? () => onTest(model.id) : undefined}
            onEdit={() => setModal(index)}
            onDelete={() => void onChange(models.filter((_, i) => i !== index))}
          />
        ))}
        <button type="button" className="settings-btn model-add" onClick={() => setModal('new')}>
          <PlusIcon size={13} />
          {t('settings.addModel')}
        </button>
      </div>
      {modal !== undefined ? (
        <ModelModal
          providerId={providerId}
          initial={modal === 'new' ? undefined : models[modal]}
          onSave={(entry) => commit(upsertModel(models, modal, entry))}
          onClose={() => setModal(undefined)}
        />
      ) : null}
    </>
  );
}
