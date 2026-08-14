import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { Box, Text, useApp, useInput, type JSX } from './kit.js';
import {
  BUILTIN_PROVIDER_IDS,
  PROVIDER_PRESETS,
  apiKeyFromEnv,
  type BuiltinProviderId,
  type ProviderPreset,
} from '../config/providers.js';
import { globalConfigPath } from '../config/paths.js';
import { saveApiKey, saveCustomProvider, saveModelChoice, setDefaultProvider } from '../config/save.js';
import { listModels } from '../model/registry.js';
import type { ResolvedProvider } from '../config/load.js';
import { ModelPicker, contextNote, type ModelOption } from './ModelPicker.js';
import { theme, glyphs } from './theme.js';
import { t } from '../i18n/index.js';

/** 本次要配置的端点:内置预设,或用户手输的 OpenAI 兼容自定义端点。 */
type Target =
  | { kind: 'builtin'; id: BuiltinProviderId; label: string; baseURL: string; preset: ProviderPreset }
  | { kind: 'custom'; id: string; label: string; baseURL: string };

type Step =
  | { kind: 'select' }
  | { kind: 'enter'; target: Target }
  | { kind: 'customUrl' }
  | { kind: 'validating'; target: Target; key: string }
  | { kind: 'error'; target: Target; key: string; message: string }
  /**
   * 到这一步**什么都还没写盘**:key、model、默认厂商在选完模型后一次性落盘
   * (persistModel)。验证通过就写 key 的老路子会在用户 esc 弃选时留下残缺
   * 条目——自定义端点尤其致命:有 baseURL 没 model,之后在厂商选择器里一选
   * 就撞 resolveProvider 的 "No model" 报错。esc = 整个放弃,一个字段都不留。
   */
  | { kind: 'pickModel'; target: Target; models: ModelOption[]; savedLine: string; key: string };

/**
 * 交互式 API key 配置:选择 provider → 粘贴 key(掩码显示)→ 对线上
 * /models 端点验证 → **直接选默认模型** → 保存到 ~/.mojocode/config.json。
 * 验证成功那一刻模型列表已经在手,顺势把它变成选择器,把"配 key"和
 * "选模型"接成一步;选完自动设为默认厂商,不再单独询问。
 *
 * 可通过 `mojocode auth` 独立运行;当任何地方都没有配置 key 时,`mojocode` 会
 * 自动启动它。列表末尾的"其他"入口支持任意 OpenAI 兼容端点(OpenRouter、
 * 本地 vLLM/Ollama 等):手输 baseURL 生成自定义 provider,key 可留空。
 *
 * saveFile/fetchImpl 是测试注入口:缺省写真实全局配置、用全局 fetch。
 */
export function AuthWizard(props: { saveFile?: string; fetchImpl?: typeof fetch }): JSX.Element {
  const { exit } = useApp();

  const [step, setStep] = createSignal<Step>({ kind: 'select' });
  const [cursor, setCursor] = createSignal(0);
  const [buffer, setBuffer] = createSignal('');
  // 本次运行中已保存 key 的 provider,让 ✓ 能立即更新。
  const [savedIds, setSavedIds] = createSignal<Set<string>>(new Set());
  // 最近一次"厂商+模型已保存为默认"的回显,显示在选择屏列表上方。
  const [lastSaved, setLastSaved] = createSignal<string | undefined>(undefined);
  // customUrl 步的行内错误(非 http(s) 等),输入变化时清除。
  const [urlError, setUrlError] = createSignal<string | undefined>(undefined);
  // pickModel 步的落盘失败提示:配置目录不可写等。吞掉它会让回车看起来
  // "没反应",用户以为配好了其实什么都没存。
  const [persistError, setPersistError] = createSignal<string | undefined>(undefined);

  /** 选择屏的行数:内置预设 + "其他"。 */
  const selectRows = () => BUILTIN_PROVIDER_IDS.length + 1;

  const targetPreset = (target: Target): ProviderPreset | undefined =>
    target.kind === 'builtin' ? target.preset : undefined;

  /** 内置预设的取 key 页面;自定义端点没有。 */
  const targetKeyUrl = (target: Target): string | undefined =>
    target.kind === 'builtin' ? target.preset.keyUrl : undefined;

  /** 组一个只够探针用的 provider(listModels 只读 baseURL/apiKey/headers)。 */
  const probeProvider = (target: Target, key: string): ResolvedProvider => ({
    id: target.id,
    label: target.label,
    baseURL: target.baseURL,
    apiKey: key || undefined,
    model: targetPreset(target)?.defaultModel ?? 'custom',
    headers: {},
    contextWindow: targetPreset(target)?.defaultContextWindow ?? 128_000,
    parallelToolCalls: true,
    reasoningEffort: 'auto',
    sdk: 'openai-compatible',
  });

  /** 保存 key(builtin/custom 分流),返回写盘路径。 */
  const persistKey = async (target: Target, key: string): Promise<string> => {
    if (target.kind === 'builtin') {
      return saveApiKey(target.id, key, props.saveFile ? { file: props.saveFile } : {});
    }
    // 空 key 的本地端点不写 apiKey 字段;重配同一地址自然更新同一条目。
    return saveCustomProvider(
      target.id,
      { baseURL: target.baseURL, apiKey: key || undefined },
      props.saveFile,
    );
  };

  /**
   * 选定模型:key + model + 默认厂商在这里一次性落盘,然后回选择屏。
   * 失败不吞——留在 pickModel 屏并把原因亮出来(persistError)。
   */
  const persistModel = async (target: Target, model: string, key: string): Promise<void> => {
    await persistKey(target, key);
    await saveModelChoice(target.id, model, props.saveFile);
    await setDefaultProvider(target.id, props.saveFile);
    setLastSaved(t('auth.savedDefault', { id: target.id, model }));
    setSavedIds((prev) => new Set(prev).add(target.id));
    setStep({ kind: 'select' });
  };

  /** 已知模型作选项:live 列表没有 note 时用预设表补上下文窗口。 */
  const modelOptions = (target: Target, ids: string[]): ModelOption[] => {
    const windows = targetPreset(target)?.contextWindows;
    return ids.map((id) => ({
      id,
      note: contextNote(windows ? windows[id as keyof typeof windows] : undefined),
    }));
  };

  // 验证放在 effect 中执行,让"验证中…"那一帧先绘制出来。
  createEffect(
    on(step, (current) => {
      if (current.kind !== 'validating') return;
      const { target, key } = current;
      let cancelled = false;
      // esc 退出验证时连底层请求一起掐断,别在挂起的端点上耗到超时。
      const controller = new AbortController();
      onCleanup(() => {
        cancelled = true;
        controller.abort();
      });

      void (async () => {
        try {
          const models = await listModels(probeProvider(target, key), {
            ...(props.fetchImpl ? { fetchImpl: props.fetchImpl } : {}),
            signal: controller.signal,
          });
          if (cancelled) return;
          // 只拿列表不写盘(见 Step 注释):落盘统一在 persistModel。
          setStep({
            kind: 'pickModel',
            target,
            models: modelOptions(target, models.map((m) => m.id)),
            savedLine: t('auth.validated', { n: models.length }),
            key,
          });
        } catch (err) {
          if (cancelled) return;
          setStep({ kind: 'error', target, key, message: (err as Error).message });
        }
      })();
    }),
  );

  /** customUrl 步:解析并校验 http(s) URL,生成自定义 provider 的 id 与展示名。 */
  const acceptCustomUrl = (): void => {
    const trimmed = buffer().trim().replace(/\/+$/, '');
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      setUrlError(t('auth.invalidUrl'));
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      setUrlError(t('auth.invalidUrl'));
      return;
    }
    // id 由主机名派生:同一地址重跑向导自然更新同一条目,不同地址不冲突。
    const id = `custom-${url.hostname.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom'}`;
    setUrlError(undefined);
    setBuffer('');
    setStep({ kind: 'enter', target: { kind: 'custom', id, label: url.hostname, baseURL: trimmed } });
  };

  useInput((input, key) => {
    const current = step();
    switch (current.kind) {
      case 'select': {
        if (key.escape) {
          exit();
        } else if (key.upArrow) {
          setCursor((c) => (c + selectRows() - 1) % selectRows());
        } else if (key.downArrow) {
          setCursor((c) => (c + 1) % selectRows());
        } else if (key.return) {
          if (cursor() >= BUILTIN_PROVIDER_IDS.length) {
            setBuffer('');
            setUrlError(undefined);
            setStep({ kind: 'customUrl' });
          } else {
            const id = BUILTIN_PROVIDER_IDS[cursor()]!;
            const preset = PROVIDER_PRESETS[id];
            setBuffer('');
            setStep({
              kind: 'enter',
              target: { kind: 'builtin', id, label: preset.label, baseURL: preset.baseURL, preset },
            });
          }
        }
        break;
      }

      case 'customUrl': {
        if (key.escape) {
          setStep({ kind: 'select' });
        } else if (key.return) {
          acceptCustomUrl();
        } else if (key.backspace || key.delete) {
          setUrlError(undefined);
          setBuffer((b) => b.slice(0, -1));
        } else if (!key.ctrl && !key.meta && input) {
          setUrlError(undefined);
          setBuffer((b) => b + input.replace(/[\r\n]/g, ''));
        }
        break;
      }

      case 'enter': {
        if (key.escape) {
          if (current.target.kind === 'custom') {
            // 回 customUrl 改地址:把已输入的 baseURL 还回草稿——buffer 是
            // 共享的,不重置的话半截 key 会顶在 URL 输入框里冒充地址。
            setBuffer(current.target.baseURL);
            setUrlError(undefined);
            setStep({ kind: 'customUrl' });
          } else {
            setBuffer('');
            setStep({ kind: 'select' });
          }
        } else if (key.return) {
          // 自定义端点允许空 key(本地服务);内置厂商必须有 key。
          const allowEmpty = current.target.kind === 'custom';
          const trimmed = buffer().trim();
          if (trimmed || allowEmpty) setStep({ kind: 'validating', target: current.target, key: trimmed });
        } else if (key.backspace || key.delete) {
          setBuffer((b) => b.slice(0, -1));
        } else if (!key.ctrl && !key.meta && input) {
          // 粘贴会作为一个多字符块到达;去掉其中的换行符。
          setBuffer((b) => b + input.replace(/[\r\n]/g, ''));
        }
        break;
      }

      case 'validating': {
        // esc 取消验证,退回输入态且保留刚输的 key;step 切换触发 effect 的
        // onCleanup,abort 挂起的探针请求(与 ProviderPicker 同款)。
        if (key.escape) {
          setBuffer(current.key);
          setStep({ kind: 'enter', target: current.target });
        }
        break;
      }

      case 'error': {
        if (key.escape) {
          setStep({ kind: 'select' });
        } else if (key.return) {
          setBuffer('');
          setStep({ kind: 'enter', target: current.target });
        } else if (input.toLowerCase() === 's') {
          // 强行保存:key 随模型选择一并落盘(persistModel),这里只是带着
          // 未验证的 key 进选模型——内置用预设已知模型兜底,自定义走手动输入行。
          const { target, key: apiKey } = current;
          const preset = targetPreset(target);
          setStep({
            kind: 'pickModel',
            target,
            models: modelOptions(target, preset ? Object.keys(preset.contextWindows) : []),
            savedLine: t('auth.unverifiedPick'),
            key: apiKey,
          });
        }
        break;
      }

      default:
        break;
    }
  });

  // pickModel 的按键(含手动输入)由内嵌的 ModelPicker 自带 useInput 处理。

  const selectList = () => (
    <Box flexDirection="column" marginTop={1}>
      <Show when={lastSaved()}>
        <Text color={theme.success}>
          {glyphs.done} {lastSaved()}
        </Text>
      </Show>
      <For each={BUILTIN_PROVIDER_IDS}>
        {(id, index) => {
          const preset = PROVIDER_PRESETS[id];
          const hasKey = () => savedIds().has(id) || apiKeyFromEnv(preset.apiKeyEnv) !== undefined;
          return (
            <Text color={index() === cursor() ? theme.accent : undefined}>
              {index() === cursor() ? '❯ ' : '  '}
              {id.padEnd(12)} {preset.label}
              {hasKey() ? (
                <Text color={theme.success}>
                  {' '}
                  {glyphs.done} {t('auth.configured')}
                </Text>
              ) : null}
            </Text>
          );
        }}
      </For>
      <Text color={cursor() === BUILTIN_PROVIDER_IDS.length ? theme.accent : undefined}>
        {cursor() === BUILTIN_PROVIDER_IDS.length ? '❯ ' : '  '}
        {'other'.padEnd(12)} {t('auth.other')}
      </Text>
      <Box marginTop={1}>
        <Text color={theme.dim}>{t('auth.selectProvider')}</Text>
      </Box>
    </Box>
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.accent}>
        {t('auth.title')}
      </Text>

      <Show when={step().kind === 'select'}>{selectList()}</Show>

      <Show when={step().kind === 'customUrl'}>
        <Box flexDirection="column" marginTop={1}>
          <Text>{t('auth.customUrl')}</Text>
          <Text color={theme.dim}>{t('auth.customUrlHint')}</Text>
          <Box marginTop={1} borderStyle="round" borderColor={theme.accent} paddingX={1}>
            <Text>
              {buffer().length === 0 ? (
                <Text color={theme.dim}>https://…/v1</Text>
              ) : (
                `${buffer()}▏`
              )}
            </Text>
          </Box>
          <Show when={urlError()}>
            <Text color={theme.error}>
              {glyphs.failed} {urlError()}
            </Text>
          </Show>
          <Text color={theme.dim}>{t('auth.customUrlConfirm')}</Text>
        </Box>
      </Show>

      <Show when={step().kind === 'enter' ? (step() as Extract<Step, { kind: 'enter' }>) : undefined}>
        {(enterStep: () => Extract<Step, { kind: 'enter' }>) => (
          <Box flexDirection="column" marginTop={1}>
            <Text>{t('auth.enterKey', { label: enterStep().target.label })}</Text>
            <Show when={targetKeyUrl(enterStep().target)}>
              {(url: () => string) => (
                <Text color={theme.dim}>{t('auth.getKeyAt', { url: url() })}</Text>
              )}
            </Show>
            <Box marginTop={1} borderStyle="round" borderColor={theme.accent} paddingX={1}>
              <Text>
                {buffer().length === 0 ? (
                  <Text color={theme.dim}>sk-…</Text>
                ) : (
                  `${'•'.repeat(Math.min(buffer().length, 40))} (${buffer().length})`
                )}
              </Text>
            </Box>
            <Text color={theme.dim}>
              {enterStep().target.kind === 'custom'
                ? t('auth.enterKeyOptionalHint')
                : t('auth.enterKeyHint')}
            </Text>
          </Box>
        )}
      </Show>

      <Show
        when={step().kind === 'validating' ? (step() as Extract<Step, { kind: 'validating' }>) : undefined}
      >
        {(validating: () => Extract<Step, { kind: 'validating' }>) => (
          <Box marginTop={1}>
            <Text color={theme.dim}>
              {glyphs.running} {t('auth.validating', { baseURL: validating().target.baseURL })}
            </Text>
          </Box>
        )}
      </Show>

      <Show when={step().kind === 'error' ? (step() as Extract<Step, { kind: 'error' }>) : undefined}>
        {(errorStep: () => Extract<Step, { kind: 'error' }>) => (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.error}>
              {glyphs.failed} {t('auth.validationFailed', { message: errorStep().message.slice(0, 300) })}
            </Text>
            <Text color={theme.dim}>{t('auth.retryHint')}</Text>
          </Box>
        )}
      </Show>

      <Show
        when={step().kind === 'pickModel' ? (step() as Extract<Step, { kind: 'pickModel' }>) : undefined}
      >
        {(pickStep: () => Extract<Step, { kind: 'pickModel' }>) => (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.success}>
              {glyphs.done} {pickStep().savedLine}
            </Text>
            <Show when={pickStep().key}>
              <Text color={theme.dim}>
                {t('auth.plaintextWarn', { path: props.saveFile ?? globalConfigPath() })}
              </Text>
            </Show>
            <Show when={persistError()}>
              <Text color={theme.error}>
                {glyphs.failed} {persistError()}
              </Text>
            </Show>
            <ModelPicker
              title={t('auth.pickModelTitle', { id: pickStep().target.id })}
              models={pickStep().models}
              initial={targetPreset(pickStep().target)?.defaultModel}
              allowManual={true}
              onPick={(model) => {
                setPersistError(undefined);
                void persistModel(pickStep().target, model, pickStep().key).catch((err: Error) =>
                  setPersistError(t('auth.saveFailed', { message: err.message })),
                );
              }}
              onCancel={() => {
                setPersistError(undefined);
                setStep({ kind: 'select' });
              }}
            />
          </Box>
        )}
      </Show>
    </Box>
  );
}
