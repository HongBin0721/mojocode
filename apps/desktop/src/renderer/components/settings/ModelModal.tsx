/**
 * 添加/编辑模型的居中弹窗(自 ModelsSettings.tsx 拆出,纯移动):模型 ID +
 * 上下文窗口 + 高级(最大输出 Token + 思考模式)。模型 id 防抖查 models.dev
 * 能力目录(providerId 供预设映射,添加供应商表单里还没有 id 就全库按模型名
 * 撞):目录命中时预填上下文窗口(用户碰过该字段/编辑既有条目则不覆盖)、
 * 行下显示库标注、思考档位只列该模型实际支持的。
 */

import React, { useEffect, useState } from 'react';
import type { ModelReasoning, ProviderModelEntry, ReasoningEffort } from '@core/schema';
import { REASONING_EFFORTS } from '@core/schema';
import { useModelCapabilities } from '../../utils/use-model-capabilities.js';
import { t, useLocale } from '../../i18n/index.js';
import { formatTokens, formatContextWindow } from '../../utils/format.js';
import { localizeEffort } from '../../utils/mode-label.js';
import { Select } from '../Select.js';
import { Modal } from '../overlays/Modal.js';
import { ChevronDownIcon, XIcon } from '../icons.js';
import { Field } from './fields.js';

export function ModelModal({
  providerId,
  initial,
  onSave,
  onClose,
}: {
  providerId?: string;
  initial: ProviderModelEntry | undefined;
  onSave: (entry: ProviderModelEntry) => void;
  onClose: () => void;
}) {
  useLocale();
  const [id, setId] = useState(initial?.id ?? '');
  const [context, setContext] = useState(
    initial?.contextWindow !== undefined ? String(initial.contextWindow) : '200000',
  );
  const [ctxTouched, setCtxTouched] = useState(initial?.contextWindow !== undefined);
  const [maxOut, setMaxOut] = useState(
    initial?.maxOutputTokens !== undefined ? String(initial.maxOutputTokens) : '',
  );
  // 思考模式:'default' = 不写字段(跟随会话档位);档位字符串;'custom' = 自定义
  // 参数对象(JSON 文本框,原样并入请求体)。
  const [thinkMode, setThinkMode] = useState<'default' | ReasoningEffort | 'custom'>(
    initial?.reasoning === undefined
      ? 'default'
      : typeof initial.reasoning === 'string'
        ? initial.reasoning
        : 'custom',
  );
  const [thinkJson, setThinkJson] = useState(
    typeof initial?.reasoning === 'object' && initial.reasoning !== null
      ? JSON.stringify(initial.reasoning, null, 2)
      : '',
  );
  const [thinkError, setThinkError] = useState(false);
  // 条目已有显式选择、或用户动过选择器,预选逻辑就不再干预。
  const [thinkTouched, setThinkTouched] = useState(initial?.reasoning !== undefined);
  const [advanced, setAdvanced] = useState(true);
  // 模型 id 防抖查能力目录;查不到 = undefined = 一切照旧(全量档位、不预填)。
  const caps = useModelCapabilities(providerId, id.trim() || undefined, { debounceMs: 350 });
  // 目录知道窗口且用户没碰过该字段时预填(编辑既有条目不覆盖)。
  useEffect(() => {
    if (caps?.contextWindow !== undefined && !ctxTouched) setContext(String(caps.contextWindow));
  }, [caps, ctxTouched]);
  // 思考模式默认中档(用户的决定):目录给出档位阶梯时预选中间一档——off 不算
  // 强度、排除后取中位,偶数个取偏低的一档(low/high/max → high,
  // low/medium/high → medium)。保存会把它显式写进条目;显式选过/既有条目不干预。
  //
  // 预选是**跟着 caps 走的**:模型 id 改到目录不认识的条目时必须退回
  // 'default',否则上一个模型的预选档位留在选择器里,保存时被静默写成用户
  // 从没选过的 reasoning——而它会盖过 provider 与全局的默认档位。
  useEffect(() => {
    if (thinkTouched) return;
    const ladder = caps?.efforts?.filter((level) => level !== 'off') ?? [];
    setThinkMode(ladder.length > 0 ? ladder[Math.floor((ladder.length - 1) / 2)]! : 'default');
  }, [caps, thinkTouched]);
  // 思考档位:目录命中只列该模型支持的;当前选中档恒保留,别把选择藏没了。
  // 'auto' 不在弹窗里列——「默认(跟随会话档位)」已经表达了"不管它",同一个
  // 下拉摆两个"不管它"只添困惑;会话级的 auto(Composer 菜单 / /think)照旧,
  // 那是唯一的"什么参数都不发"回退口。手写配置里 reasoning:'auto' 的旧条目
  // 编辑时仍显示(当前档保留规则),不藏用户的选择。
  const known = caps?.efforts;
  const effortOptions = (
    known !== undefined
      ? REASONING_EFFORTS.filter((level) => known.includes(level) || level === thinkMode)
      : REASONING_EFFORTS
  ).filter((level) => level !== 'auto' || thinkMode === 'auto');
  const submit = () => {
    const trimmed = id.trim();
    if (!trimmed) return;
    // 思考模式:custom 必须是合法 JSON 对象,解析失败标红、不提交。
    let reasoning: ModelReasoning | undefined;
    if (thinkMode === 'custom') {
      try {
        const parsed: unknown = JSON.parse(thinkJson);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        reasoning = parsed as ModelReasoning;
      } catch {
        setThinkError(true);
        return;
      }
    } else if (thinkMode !== 'default') {
      reasoning = thinkMode;
    }
    const ctx = Math.floor(Number(context));
    const out = Math.floor(Number(maxOut));
    onSave({
      id: trimmed,
      // 弹窗不编辑 label(手写配置才有),编辑既有条目时原样带上,别静默丢掉。
      ...(initial?.label !== undefined ? { label: initial.label } : {}),
      ...(context.trim() !== '' && Number.isFinite(ctx) && ctx > 0 ? { contextWindow: ctx } : {}),
      ...(maxOut.trim() !== '' && Number.isFinite(out) && out > 0 ? { maxOutputTokens: out } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    });
  };
  const title = initial ? t('settings.editModelTitle') : t('settings.addModel');
  // portal/backdrop/Esc(捕获相 + 浮层栈仲裁:思考模式的 Select 开着时它是
  // 栈顶,Esc 只关它)统一由 Modal 承担;SettingsPage 的冒泡 Esc 仍被拦住。
  return (
    <Modal variant="modal" ariaLabel={title} onClose={onClose}>
      <div className="modal-head">
        <div className="modal-title">{title}</div>
        <button type="button" className="section-icon" title={t('settings.cancel')} onClick={onClose}>
          <XIcon size={14} />
        </button>
      </div>
      <Field label={t('settings.modelId')}>
        <input
          className="setting-input"
          autoFocus
          value={id}
          placeholder={t('settings.modelIdPlaceholder')}
          onChange={(e) => setId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
      </Field>
      <Field label={t('settings.contextWindow')}>
        <input
          className="setting-input"
          type="number"
          min={1}
          value={context}
          onChange={(e) => {
            setCtxTouched(true);
            setContext(e.target.value);
          }}
        />
        {caps ? (
          <div className="field-hint">
            {t('settings.catalogHint', {
              context: caps.contextWindow !== undefined ? formatContextWindow(caps.contextWindow) : '—',
              output: caps.maxOutputTokens !== undefined ? formatTokens(caps.maxOutputTokens) : '—',
            })}
          </div>
        ) : null}
      </Field>
      <button
        type="button"
        className={`modal-advanced ${advanced ? 'modal-advanced-open' : ''}`}
        onClick={() => setAdvanced((v) => !v)}
      >
        <ChevronDownIcon size={13} />
        {t('settings.advanced')}
      </button>
      {advanced ? (
        <>
          <Field label={t('settings.maxOutput')}>
            <input
              className="setting-input"
              type="number"
              min={1}
              value={maxOut}
              placeholder={t('settings.maxOutputPlaceholder')}
              onChange={(e) => setMaxOut(e.target.value)}
            />
          </Field>
          <Field label={t('settings.thinking')}>
            <Select
              value={thinkMode}
              ariaLabel={t('settings.thinking')}
              options={[
                { value: 'default', label: t('settings.thinkingDefault') },
                ...effortOptions.map((level) => ({ value: level, label: localizeEffort(level) })),
                { value: 'custom', label: t('settings.thinkingCustom') },
              ]}
              onChange={(next) => {
                setThinkError(false);
                setThinkTouched(true);
                setThinkMode(next as typeof thinkMode);
              }}
            />
          </Field>
          {thinkMode === 'custom' ? (
            <div className="field">
              <textarea
                className={`setting-input setting-textarea ${thinkError ? 'setting-input-invalid' : ''}`}
                rows={4}
                value={thinkJson}
                placeholder={'{\n  "thinking": { "type": "enabled" }\n}'}
                onChange={(e) => {
                  setThinkError(false);
                  setThinkJson(e.target.value);
                }}
              />
              <div className={`field-hint ${thinkError ? 'field-hint-error' : ''}`}>
                {thinkError ? t('settings.thinkingInvalidJson') : t('settings.thinkingCustomHint')}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      <div className="modal-actions">
        <button type="button" className="settings-btn" onClick={onClose}>
          {t('settings.cancel')}
        </button>
        <button
          type="button"
          className="settings-btn settings-btn-primary"
          disabled={!id.trim()}
          onClick={submit}
        >
          {t('settings.save')}
        </button>
      </div>
    </Modal>
  );
}
