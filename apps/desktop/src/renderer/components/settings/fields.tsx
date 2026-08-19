/**
 * 设置页共用的表单原子(自 ModelsSettings.tsx 拆出,纯移动):
 * Field 纵向字段 / KeyInput 打码输入 / ApiFormatField 单选禁用行。
 */

import React, { useState } from 'react';
import { t } from '../../i18n/index.js';
import { Select } from '../Select.js';
import { EyeIcon, EyeOffIcon } from '../icons.js';

/** 纵向字段:标签在上、控件全宽(详情 / 添加表单 / 弹窗共用的排版)。 */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {children}
    </div>
  );
}

/**
 * API Key 输入:打码 + 眼睛切换。脱敏快照读不回真实 key,眼睛只对本次输入
 * 生效;已配置且未输入时用圆点占位符示意。眼睛按钮 onMouseDown preventDefault
 * 保住输入框焦点——否则点眼睛先触发 blur,半截 key 就被提交了。
 */
export function KeyInput({
  hasKey,
  value,
  onChange,
  onCommit,
}: {
  hasKey: boolean;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="key-wrap">
      <input
        className="setting-input"
        type={show ? 'text' : 'password'}
        value={value}
        placeholder={hasKey ? '••••••••••••••••••••••••••••••••' : t('settings.apiKeyPlaceholder')}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      <button
        type="button"
        className="key-eye"
        title={show ? t('settings.hideKey') : t('settings.showKey')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setShow((v) => !v)}
      >
        {show ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
      </button>
    </div>
  );
}

/**
 * API 格式行:core 只走 OpenAI 兼容端点,单选项禁用——为对齐 ZCode 的布局
 * 保留这一行,同时不假装支持别的协议。
 */
export function ApiFormatField() {
  return (
    <Field label={t('settings.apiFormat')}>
      <Select
        value="openai"
        disabled
        ariaLabel={t('settings.apiFormat')}
        options={[{ value: 'openai', label: t('settings.apiFormatOpenAI') }]}
      />
    </Field>
  );
}
