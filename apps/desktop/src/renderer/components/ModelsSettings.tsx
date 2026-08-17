/**
 * 设置页·模型设置(ZCode 形态的双栏卡片):
 *  - 左列:预设供应商 / 自定义供应商两组 + 「添加供应商」;已配置的条目
 *    带绿点,选中行高亮。
 *  - 右栏:选中供应商的详情——标题(自定义条目可改名)+ 「已启用」徽章
 *    (或「启用」按钮,走 switch RPC)、Base URL / API 格式 / API Key 纵向
 *    堆叠字段(key 只写不读:快照是脱敏副本,已配置用圆点占位;失焦或回车
 *    提交)、模型列表(增删改走居中弹窗),以及自定义条目的整条删除。
 *  - 「添加供应商」表单对齐 ZCode:名称 + Base URL + API Key + API 格式 +
 *    初始模型列表,配置键由名称派生(deriveProviderId)。
 *  - 「添加模型」弹窗:模型 ID + 上下文窗口(数字)+ 高级(最大输出 Token,
 *    经 resolveProvider 透传 streamText,是真实生效的字段)。
 *
 * 所有写操作走 saveProvider/deleteProvider RPC——server 侧合并内存配置并
 * 落盘 `~/.mojocode/config.json`,变更后的脱敏快照经 state 推送回流,本组件
 * 不维护镜像副本(输入草稿除外)。Composer 的模型选择器直接消费这里配置的
 * models 列表(utils/model-settings.ts 的 configuredModelGroups)。
 */

import React, { useEffect, useState } from 'react';
import type { ModelReasoning, ProviderConfig, ProviderModelEntry, ReasoningEffort } from '@core/schema';
import { REASONING_EFFORTS } from '@core/schema';
import type { ModelTestSummary } from '../../shared/ipc.js';
import { useModelCapabilities } from '../utils/use-model-capabilities.js';
import { PROVIDER_PRESETS, isBuiltinProvider } from '@core/providers';
import { useDesktopStore } from '../state/desktopStore.js';
import { t, useLocale } from '../i18n/index.js';
import { formatTokens } from '../utils/format.js';
import { localizeEffort } from '../utils/mode-label.js';
import { deriveProviderId, providerLabel, providerList, upsertModel } from '../utils/model-settings.js';
import { Select } from './Select.js';
import {
  ChevronDownIcon,
  EyeIcon,
  EyeOffIcon,
  LinkIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  XIcon,
} from './icons.js';

/** 纵向字段:标签在上、控件全宽(详情 / 添加表单 / 弹窗共用的排版)。 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
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
function KeyInput({
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
function ApiFormatField() {
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

/**
 * 添加/编辑模型的居中弹窗:模型 ID + 上下文窗口 + 高级(最大输出 Token +
 * 思考模式)。模型 id 防抖查 models.dev 能力目录(providerId 供预设映射,
 * 添加供应商表单里还没有 id 就全库按模型名撞):目录命中时预填上下文窗口
 * (用户碰过该字段/编辑既有条目则不覆盖)、行下显示库标注、思考档位只列
 * 该模型实际支持的。
 */
function ModelModal({
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
  // Esc 在捕获阶段拦下、只关弹窗:SettingsPage 在冒泡阶段听 Esc 关整个设置页。
  // 思考模式选择器的浮层开着时让给它——它的捕获监听注册得晚、排在本处之后,
  // 这里不让行会连弹窗一起关掉。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.select-menu')) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
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
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-card" role="dialog" aria-label={title}>
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
                context: caps.contextWindow !== undefined ? formatTokens(caps.contextWindow) : '—',
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
      </div>
    </div>
  );
}

/** 一次「测试模型」的行内状态(按模型 id 记在 ProviderDetail 里)。 */
type ModelTestState =
  | { state: 'testing' }
  | { state: 'ok' }
  | { state: 'fail'; detail: string };

/**
 * 模型行:id + 上下文徽章 + 测试/编辑/删除;测试结果渲染成行下的胶囊
 * (绿 = 连通,红 = 失败并带端点原因)。onTest 缺省时不渲染链接按钮
 * (添加表单里的本地条目还没落盘,无从测试)。
 */
function ModelRow({
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
          <span className="model-row-ctx">{formatTokens(model.contextWindow)}</span>
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

/**
 * 添加供应商表单(右栏整体替换,对齐 ZCode):名称 + Base URL + API Key +
 * API 格式 + 初始模型列表,一次 saveProvider 落盘。配置键由名称派生。
 */
function AddProviderForm({ onDone }: { onDone: (id: string) => void }) {
  useLocale();
  const config = useDesktopStore((s) => s.snapshot?.config);
  const [name, setName] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ProviderModelEntry[]>([]);
  const [modal, setModal] = useState<number | 'new' | undefined>();
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
    void window.mojocode
      .rpc({ kind: 'saveProvider', id, config: patch })
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
        <div className="model-rows">
          {models.map((model, index) => (
            <ModelRow
              key={`${index}-${model.id}`}
              model={model}
              current={false}
              onEdit={() => setModal(index)}
              onDelete={() => setModels(models.filter((_, i) => i !== index))}
            />
          ))}
          <button type="button" className="settings-btn model-add" onClick={() => setModal('new')}>
            <PlusIcon size={13} />
            {t('settings.addModel')}
          </button>
        </div>
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
      {modal !== undefined ? (
        <ModelModal
          initial={modal === 'new' ? undefined : models[modal]}
          onSave={(entry) => {
            setModels(upsertModel(models, modal, entry));
            setModal(undefined);
          }}
          onClose={() => setModal(undefined)}
        />
      ) : null}
    </div>
  );
}

/* 添加供应商表单里的弹窗不传 providerId(条目还没落盘,没有预设映射),
 * 能力查询回退到全库按模型名撞。 */

/** 右栏:选中供应商的详情与模型 CRUD。onRemoved:整条删除后由父组件复位选中。 */
function ProviderDetail({ id, onRemoved }: { id: string; onRemoved: () => void }) {
  useLocale();
  const snapshot = useDesktopStore((s) => s.snapshot);
  const [keyDraft, setKeyDraft] = useState('');
  const [urlDraft, setUrlDraft] = useState<string | undefined>();
  const [nameDraft, setNameDraft] = useState<string | undefined>();
  const [modal, setModal] = useState<number | 'new' | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [tests, setTests] = useState<Record<string, ModelTestState>>({});

  const override = snapshot?.config.providers[id];
  const builtin = isBuiltinProvider(id);
  const preset = builtin ? PROVIDER_PRESETS[id as keyof typeof PROVIDER_PRESETS] : undefined;
  const active = snapshot?.provider.id === id;
  const models = override?.models ?? [];
  const hasKey = override?.apiKey !== undefined;
  const baseURL = override?.baseURL ?? preset?.baseURL ?? '';

  const save = (config: ProviderConfig, after?: () => void) => {
    setError(undefined);
    void window.mojocode
      .rpc({ kind: 'saveProvider', id, config })
      .then(after)
      .catch((err: Error) => setError(err.message));
  };

  const saveModels = (next: ProviderModelEntry[]) => save({ models: next }, () => setModal(undefined));

  // 不带 model:switchProvider 会走该 provider 自己的默认(override.model ??
  // preset.defaultModel)。硬塞 models[0] 会让「启用」把用户配置的默认模型
  // 换成列表里碰巧排第一的那个。
  const enable = () => {
    setError(undefined);
    void window.mojocode
      .rpc({ kind: 'switch', change: { provider: id } })
      .catch((err: Error) => setError(err.message));
  };

  // 「测试模型」:server 侧向对话端点发一次最小补全;结果(含失败原因)按
  // 模型 id 记成行下胶囊。传输层错误(RPC 断连)同样落到红胶囊,不走 error 区。
  const runTest = (model: string) => {
    setTests((prev) => ({ ...prev, [model]: { state: 'testing' } }));
    void window.mojocode
      .rpc({ kind: 'testModel', id, model })
      .then((raw) => {
        const result = raw as ModelTestSummary;
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
    void window.mojocode
      .rpc({ kind: 'deleteProvider', id })
      .then(onRemoved)
      .catch((err: Error) => setError(err.message));
  };

  // key/URL/名称都是失焦或回车提交(ZCode 无显式保存按钮);空值 / 没变 / 不合法时静默丢弃草稿。
  const commitKey = () => {
    const value = keyDraft.trim();
    if (!value) return;
    save({ apiKey: value }, () => setKeyDraft(''));
  };
  const commitUrl = () => {
    if (urlDraft === undefined) return;
    const value = urlDraft.trim();
    if (value === baseURL || !/^https?:\/\//.test(value)) {
      setUrlDraft(undefined);
      return;
    }
    save({ baseURL: value }, () => setUrlDraft(undefined));
  };
  const commitName = () => {
    if (nameDraft === undefined) return;
    const value = nameDraft.trim();
    if (!value || value === providerLabel(id, override)) {
      setNameDraft(undefined);
      return;
    }
    save({ label: value }, () => setNameDraft(undefined));
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
        <div className="model-rows">
          {models.map((model, index) => (
            <ModelRow
              key={`${index}-${model.id}`}
              model={model}
              current={active && snapshot?.provider.model === model.id}
              test={tests[model.id]}
              onTest={() => runTest(model.id)}
              onEdit={() => setModal(index)}
              onDelete={() => saveModels(models.filter((_, i) => i !== index))}
            />
          ))}
          <button type="button" className="settings-btn model-add" onClick={() => setModal('new')}>
            <PlusIcon size={13} />
            {t('settings.addModel')}
          </button>
        </div>
      </div>
      {error ? <div className="settings-error">{error}</div> : null}
      {modal !== undefined ? (
        <ModelModal
          providerId={id}
          initial={modal === 'new' ? undefined : models[modal]}
          onSave={(entry) => saveModels(upsertModel(models, modal, entry))}
          onClose={() => setModal(undefined)}
        />
      ) : null}
    </div>
  );
}

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
