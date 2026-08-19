/**
 * 模型行(自 ModelsSettings.tsx 拆出,纯移动):id + 上下文徽章 +
 * 测试/编辑/删除;测试结果渲染成行下的胶囊(绿 = 连通,红 = 失败并带端点
 * 原因)。onTest 缺省时不渲染链接按钮(添加表单里的本地条目还没落盘,
 * 无从测试)。
 */

import React from 'react';
import type { ProviderModelEntry } from '@core/schema';
import { t } from '../../i18n/index.js';
import { formatContextWindow } from '../../utils/format.js';
import { LinkIcon, PencilIcon, TrashIcon } from '../icons.js';

/** 一次「测试模型」的行内状态(按模型 id 记在 ProviderDetail 里)。 */
export type ModelTestState =
  | { state: 'testing' }
  | { state: 'ok' }
  | { state: 'fail'; detail: string };

export function ModelRow({
  model,
  current,
  test,
  onTest,
  onEdit,
  onDelete,
}: {
  model: ProviderModelEntry;
  current: boolean;
  test?: ModelTestState;
  onTest?: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <div className={`model-row ${current ? 'model-row-current' : ''}`}>
        <span className="model-row-id">{model.label ?? model.id}</span>
        {model.contextWindow ? (
          <span className="model-row-ctx">{formatContextWindow(model.contextWindow)}</span>
        ) : null}
        <span className="model-row-actions">
          {onTest ? (
            <button
              type="button"
              className="section-icon"
              title={t('settings.testModel')}
              disabled={test?.state === 'testing'}
              onClick={onTest}
            >
              <LinkIcon size={13} />
            </button>
          ) : null}
          <button type="button" className="section-icon" title={t('settings.edit')} onClick={onEdit}>
            <PencilIcon size={13} />
          </button>
          <button type="button" className="section-icon" title={t('settings.delete')} onClick={onDelete}>
            <TrashIcon size={13} />
          </button>
        </span>
      </div>
      {test ? (
        <div className={`model-test model-test-${test.state}`}>
          {test.state === 'testing'
            ? t('settings.testing')
            : test.state === 'ok'
              ? t('settings.testOk')
              : t('settings.testFail', { message: test.detail })}
        </div>
      ) : null}
    </>
  );
}
