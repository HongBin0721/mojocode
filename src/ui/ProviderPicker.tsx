import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { Box, Text, useInput, type JSX } from './kit.js';
import { theme, glyphs } from './theme.js';
import { t } from '../i18n/index.js';

const WINDOW = 8;

/** 一行厂商。hasKey 决定选中后是直接切换还是就地输入 key。 */
export interface ProviderRow {
  id: string;
  label: string;
  /** 实际探测的端点(validating 一行展示);缺省用 label。 */
  baseURL?: string;
  /** 内置预设的取 key 页面,输入框上方展示。 */
  keyUrl?: string;
  /** 已有可用 key(env 或配置)——直接切换;否则进入就地输入。 */
  hasKey: boolean;
  current: boolean;
  /** 本地端点无需凭据:输入框允许空确认(自定义 provider)。 */
  keyOptional?: boolean;
}

interface Props {
  rows: ProviderRow[];
  /**
   * 用 key 打一次 /models 探针(返回模型数)。由 App 注入——要拿预设或
   * 配置里的 baseURL 组装请求;组件保持无 IO,测试可替换。signal 在用户
   * 验证中按 esc 时触发 abort,别让挂起的端点占着请求几分钟。
   */
  probe: (id: string, key: string, signal?: AbortSignal) => Promise<number>;
  /** apiKey 有值 = 本次就地输入并验证(或强行保存)的新 key;落盘归调用方。 */
  onSwitch: (id: string, apiKey?: string) => void;
  onCancel: () => void;
}

type Phase =
  | { kind: 'list' }
  | { kind: 'enter'; row: ProviderRow }
  | { kind: 'validating'; row: ProviderRow; key: string }
  | { kind: 'error'; row: ProviderRow; key: string; message: string };

/** 选中未配 key 的行后就地输入;行信息在三个阶段间保留。 */
type KeyPhase = Extract<Phase, { kind: 'enter' | 'validating' | 'error' }>;

/**
 * `/provider` 的厂商选择器。已配 key 的厂商回车即切;没配的就地弹 key 输入,
 * 验证成功才交给调用方落盘切换——把原来"切过去直接吃一个 MissingKeyError"
 * 的断路接上。
 *
 * 与 ModelPicker 同一套窗口化结构;enter/validating/error 状态机与
 * AuthWizard 同构(验证放在 effect 里,让"验证中…"那一帧先画出来)。
 */
export function ProviderPicker(props: Props): JSX.Element {
  const [phase, setPhase] = createSignal<Phase>({ kind: 'list' });
  const [cursor, setCursor] = createSignal(Math.max(0, props.rows.findIndex((r) => r.current)));
  const [buffer, setBuffer] = createSignal('');

  const keyPhase = createMemo(() => {
    const current = phase();
    return current.kind === 'list' ? undefined : (current as KeyPhase);
  });

  const beginKeyEntry = (row: ProviderRow): void => {
    setBuffer('');
    setPhase({ kind: 'enter', row });
  };

  createEffect(
    on(phase, (current) => {
      if (current.kind !== 'validating') return;
      const { row, key } = current;
      let cancelled = false;
      // esc 退出验证时连底层请求一起掐断——不 abort 的话 fetch 还挂在
      // undici 的默认超时上,占着连接跑完全程。
      const controller = new AbortController();
      onCleanup(() => {
        cancelled = true;
        controller.abort();
      });
      void (async () => {
        try {
          await props.probe(row.id, key, controller.signal);
          if (cancelled) return;
          props.onSwitch(row.id, key);
        } catch (err) {
          if (cancelled) return;
          setPhase({ kind: 'error', row, key, message: (err as Error).message });
        }
      })();
    }),
  );

  useInput((input, key) => {
    const current = phase();
    switch (current.kind) {
      case 'list': {
        if (key.escape) {
          props.onCancel();
        } else if (key.upArrow) {
          setCursor((c) => (c + props.rows.length - 1) % props.rows.length);
        } else if (key.downArrow) {
          setCursor((c) => (c + 1) % props.rows.length);
        } else if (key.return) {
          const row = props.rows[cursor()];
          if (!row) return;
          if (row.hasKey) props.onSwitch(row.id);
          else beginKeyEntry(row);
        }
        break;
      }

      case 'enter': {
        if (key.escape) {
          setPhase({ kind: 'list' });
        } else if (key.return) {
          const trimmed = buffer().trim();
          // 本地端点允许空 key:没有可验证的凭据,直接切。
          if (!trimmed && current.row.keyOptional) {
            props.onSwitch(current.row.id);
            return;
          }
          if (trimmed) setPhase({ kind: 'validating', row: current.row, key: trimmed });
        } else if (key.backspace || key.delete) {
          setBuffer((b) => b.slice(0, -1));
        } else if (!key.ctrl && !key.meta && input) {
          // 粘贴会作为一个多字符块到达;去掉其中的换行符。
          setBuffer((b) => b + input.replace(/[\r\n]/g, ''));
        }
        break;
      }

      case 'validating': {
        // esc 取消验证,退回输入态且保留刚输的 key;phase 切换触发 effect
        // 的 onCleanup,abort 挂起的探针请求。
        if (key.escape) {
          setBuffer(current.key);
          setPhase({ kind: 'enter', row: current.row });
        }
        break;
      }

      case 'error': {
        if (key.escape) {
          setPhase({ kind: 'list' });
        } else if (key.return) {
          beginKeyEntry(current.row);
        } else if (input.toLowerCase() === 's') {
          props.onSwitch(current.row.id, current.key);
        }
        break;
      }

      default:
        break;
    }
  });

  const windowStart = createMemo(() =>
    Math.max(0, Math.min(cursor() - Math.floor(WINDOW / 2), props.rows.length - WINDOW)),
  );
  const visible = createMemo(() => props.rows.slice(windowStart(), windowStart() + WINDOW));

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text bold color={theme.accent}>
          {t('providerpicker.title')}
        </Text>

        <Show when={!keyPhase()}>
          <Show when={windowStart() > 0}>
            <Text color={theme.dim}>{t('selector.moreAbove', { n: windowStart() })}</Text>
          </Show>
          <For each={visible()}>
            {(row, i) => {
              const index = () => windowStart() + i();
              const active = () => index() === cursor();
              return (
                // 点击已配 key 的厂商即切换;未配的进入就地输入。
                <Text
                  color={active() ? theme.accent : undefined}
                  wrap="truncate-end"
                  onClick={() => (row.hasKey ? props.onSwitch(row.id) : beginKeyEntry(row))}
                >
                  {active() ? `${glyphs.pointer} ` : '  '}
                  {row.id.padEnd(12)} {row.label}
                  <Show when={row.current}>
                    <Text color={theme.success}>
                      {' '}
                      {glyphs.done} {t('selector.current')}
                    </Text>
                  </Show>
                  <Show when={!row.hasKey}>
                    <Text color={theme.dim}> · {t('providerpicker.noKey')}</Text>
                  </Show>
                </Text>
              );
            }}
          </For>
          <Show when={windowStart() + WINDOW < props.rows.length}>
            <Text color={theme.dim}>
              {t('selector.moreBelow', { n: props.rows.length - windowStart() - WINDOW })}
            </Text>
          </Show>
        </Show>

        <Show when={keyPhase()} keyed>
          {(current: KeyPhase) => (
            <Box flexDirection="column">
              <Text>{t('auth.enterKey', { label: current.row.label })}</Text>
              <Show when={current.row.keyUrl}>
                <Text color={theme.dim}>{t('auth.getKeyAt', { url: current.row.keyUrl! })}</Text>
              </Show>
              <Show when={current.kind === 'enter'}>
                <Box marginTop={1} borderStyle="round" borderColor={theme.accent} paddingX={1}>
                  <Text>
                    {buffer().length === 0 ? (
                      <Text color={theme.dim}>
                        {current.row.keyOptional ? t('providerpicker.keyOptional') : 'sk-…'}
                      </Text>
                    ) : (
                      `${'•'.repeat(Math.min(buffer().length, 40))} (${buffer().length})`
                    )}
                  </Text>
                </Box>
                <Text color={theme.dim}>
                  {current.row.keyOptional
                    ? t('providerpicker.enterHintOptional')
                    : t('auth.enterKeyHint')}
                </Text>
              </Show>
              <Show when={current.kind === 'validating'}>
                <Text color={theme.dim}>
                  {glyphs.running}{' '}
                  {t('auth.validating', { baseURL: current.row.baseURL ?? current.row.label })}
                </Text>
              </Show>
              <Show when={current.kind === 'error' ? current : undefined} keyed>
                {(err: Extract<Phase, { kind: 'error' }>) => (
                  <Text color={theme.error}>
                    {glyphs.failed}{' '}
                    {t('auth.validationFailed', { message: err.message.slice(0, 300) })}
                  </Text>
                )}
              </Show>
              <Show when={current.kind === 'error'}>
                <Text color={theme.dim}>{t('auth.retryHint')}</Text>
              </Show>
            </Box>
          )}
        </Show>
      </Box>
      <Box paddingLeft={2}>
        <Text color={theme.dim}>{t('selector.hint')}</Text>
      </Box>
    </Box>
  );
}
