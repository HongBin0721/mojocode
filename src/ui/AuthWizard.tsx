import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { Box, Text, useApp, useInput, type JSX } from './kit.js';
import {
  BUILTIN_PROVIDER_IDS,
  PROVIDER_PRESETS,
  apiKeyFromEnv,
  type BuiltinProviderId,
} from '../config/providers.js';
import { globalConfigPath } from '../config/paths.js';
import { saveApiKey, setDefaultProvider } from '../config/save.js';
import { listModels } from '../model/registry.js';
import { theme, glyphs } from './theme.js';
import { t } from '../i18n/index.js';

type Step =
  | { kind: 'select' }
  | { kind: 'enter'; id: BuiltinProviderId }
  | { kind: 'validating'; id: BuiltinProviderId; key: string }
  | { kind: 'error'; id: BuiltinProviderId; key: string; message: string }
  | { kind: 'askDefault'; id: BuiltinProviderId; savedLine: string }
  | { kind: 'another' }
  | { kind: 'done' };

/**
 * 交互式 API key 配置:选择 provider,粘贴 key(掩码显示),对线上
 * /models 端点验证,保存到 ~/.mojocode/config.json。
 *
 * 可通过 `mojocode auth` 独立运行;当任何地方都没有配置 key 时,`mojocode` 会
 * 自动启动它。
 */
export function AuthWizard(): JSX.Element {
  const { exit } = useApp();

  const [step, setStep] = createSignal<Step>({ kind: 'select' });
  const [cursor, setCursor] = createSignal(0);
  const [buffer, setBuffer] = createSignal('');
  // 本次运行中已保存 key 的 provider,让 ✓ 能立即更新。
  const [savedIds, setSavedIds] = createSignal<Set<string>>(new Set());

  // 验证放在 effect 中执行,让"验证中…"那一帧先绘制出来。
  createEffect(
    on(step, (current) => {
      if (current.kind !== 'validating') return;
      const { id, key } = current;
      const preset = PROVIDER_PRESETS[id];
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });

      void (async () => {
        try {
          const models = await listModels({
            id,
            label: preset.label,
            baseURL: preset.baseURL,
            apiKey: key,
            model: preset.defaultModel,
            headers: {},
            contextWindow: preset.defaultContextWindow,
            parallelToolCalls: true,
            reasoningEffort: 'auto',
            sdk: 'openai-compatible',
          });
          if (cancelled) return;
          const path = await saveApiKey(id, key);
          setSavedIds((prev) => new Set(prev).add(id));
          setStep({ kind: 'askDefault', id, savedLine: t('auth.saved', { path, n: models.length }) });
        } catch (err) {
          if (cancelled) return;
          setStep({ kind: 'error', id, key, message: (err as Error).message });
        }
      })();
    }),
  );

  useInput((input, key) => {
    const current = step();
    switch (current.kind) {
      case 'select': {
        if (key.escape) {
          exit();
        } else if (key.upArrow) {
          setCursor((c) => (c + BUILTIN_PROVIDER_IDS.length - 1) % BUILTIN_PROVIDER_IDS.length);
        } else if (key.downArrow) {
          setCursor((c) => (c + 1) % BUILTIN_PROVIDER_IDS.length);
        } else if (key.return) {
          setBuffer('');
          setStep({ kind: 'enter', id: BUILTIN_PROVIDER_IDS[cursor()]! });
        }
        break;
      }

      case 'enter': {
        if (key.escape) {
          setStep({ kind: 'select' });
        } else if (key.return) {
          const trimmed = buffer().trim();
          if (trimmed) setStep({ kind: 'validating', id: current.id, key: trimmed });
        } else if (key.backspace || key.delete) {
          setBuffer((b) => b.slice(0, -1));
        } else if (!key.ctrl && !key.meta && input) {
          // 粘贴会作为一个多字符块到达;去掉其中的换行符。
          setBuffer((b) => b + input.replace(/[\r\n]/g, ''));
        }
        break;
      }

      case 'error': {
        if (key.escape) {
          setStep({ kind: 'select' });
        } else if (key.return) {
          setBuffer('');
          setStep({ kind: 'enter', id: current.id });
        } else if (input.toLowerCase() === 's') {
          const { id, key: apiKey } = current;
          void saveApiKey(id, apiKey).then((path) => {
            setSavedIds((prev) => new Set(prev).add(id));
            setStep({ kind: 'askDefault', id, savedLine: t('auth.savedUnverified', { path }) });
          });
        }
        break;
      }

      case 'askDefault': {
        if (input.toLowerCase() === 'y') {
          void setDefaultProvider(current.id).then(() => setStep({ kind: 'another' }));
        } else if (input.toLowerCase() === 'n' || key.escape || key.return) {
          setStep({ kind: 'another' });
        }
        break;
      }

      case 'another': {
        if (input.toLowerCase() === 'y') {
          setStep({ kind: 'select' });
        } else {
          setStep({ kind: 'done' });
          exit();
        }
        break;
      }

      default:
        break;
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.accent}>
        {t('auth.title')}
      </Text>

      <Show when={step().kind === 'select'}>
        <Box flexDirection="column" marginTop={1}>
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
          <Box marginTop={1}>
            <Text color={theme.dim}>{t('auth.selectProvider')}</Text>
          </Box>
        </Box>
      </Show>

      <Show when={step().kind === 'enter' ? (step() as Extract<Step, { kind: 'enter' }>) : undefined}>
        {(enterStep: () => Extract<Step, { kind: 'enter' }>) => (
          <Box flexDirection="column" marginTop={1}>
            <Text>{t('auth.enterKey', { label: PROVIDER_PRESETS[enterStep().id].label })}</Text>
            <Text color={theme.dim}>{t('auth.getKeyAt', { url: PROVIDER_PRESETS[enterStep().id].keyUrl })}</Text>
            <Box marginTop={1} borderStyle="round" borderColor={theme.accent} paddingX={1}>
              <Text>
                {buffer().length === 0 ? (
                  <Text color={theme.dim}>sk-…</Text>
                ) : (
                  `${'•'.repeat(Math.min(buffer().length, 40))} (${buffer().length})`
                )}
              </Text>
            </Box>
            <Text color={theme.dim}>{t('auth.enterKeyHint')}</Text>
          </Box>
        )}
      </Show>

      <Show
        when={step().kind === 'validating' ? (step() as Extract<Step, { kind: 'validating' }>) : undefined}
      >
        {(validating: () => Extract<Step, { kind: 'validating' }>) => (
          <Box marginTop={1}>
            <Text color={theme.dim}>
              {glyphs.running} {t('auth.validating', { baseURL: PROVIDER_PRESETS[validating().id].baseURL })}
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
        when={step().kind === 'askDefault' ? (step() as Extract<Step, { kind: 'askDefault' }>) : undefined}
      >
        {(askStep: () => Extract<Step, { kind: 'askDefault' }>) => (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.success}>
              {glyphs.done} {askStep().savedLine}
            </Text>
            <Text color={theme.dim}>{t('auth.plaintextWarn', { path: globalConfigPath() })}</Text>
            <Box marginTop={1}>
              <Text>{t('auth.setDefault', { id: askStep().id })}</Text>
            </Box>
          </Box>
        )}
      </Show>

      <Show when={step().kind === 'another'}>
        <Box marginTop={1}>
          <Text>{t('auth.another')}</Text>
        </Box>
      </Show>

      <Show when={step().kind === 'done'}>
        <Box marginTop={1}>
          <Text color={theme.success}>{t('auth.done')}</Text>
        </Box>
      </Show>
    </Box>
  );
}
