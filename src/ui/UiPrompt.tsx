import { createMemo, createSignal, For, Show } from 'solid-js';
import { Box, Text, useInput, type JSX } from './kit.js';
import type { UiAnswer, UiRequest } from '../core/extension-types.js';
import { theme, glyphs } from './theme.js';
import { t } from '../i18n/index.js';
import { applyTextKey, centeredWindowStart } from './picker-utils.js';

const WINDOW = 8;

interface Props {
  request: UiRequest;
  /** select:选中项或 undefined(esc);confirm:布尔;input:文本或 undefined(esc)。 */
  onAnswer: (answer: UiAnswer) => void;
}

/**
 * 扩展向用户提问(`ctx.ui.select / confirm / input`)的提示框。与回退选择器
 * 同一条互斥分支:它渲染期间 Input 已卸载,自带的 useInput 独占键盘。三种
 * 形态共用一个组件而不是三个,因为它们只差列表内容与回车的语义——select
 * 是任意项、confirm 是「是/否」两项、input 是一行文本。
 */
export function UiPrompt(props: Props): JSX.Element {
  const [cursor, setCursor] = createSignal(0);
  const [buffer, setBuffer] = createSignal('');

  const items = createMemo((): string[] => {
    const request = props.request;
    if (request.kind === 'select') return request.items;
    if (request.kind === 'confirm') return [t('uiPrompt.yes'), t('uiPrompt.no')];
    return [];
  });

  const submit = (index: number): void => {
    const request = props.request;
    if (request.kind === 'select') props.onAnswer(request.items[index]);
    else if (request.kind === 'confirm') props.onAnswer(index === 0);
  };

  useInput((input, key) => {
    const request = props.request;
    if (key.escape) {
      props.onAnswer(request.kind === 'confirm' ? false : undefined);
      return;
    }
    if (request.kind === 'input') {
      // 打字/退格/粘贴的语义与手动输入态、扩展的 textInput 同一份实现。
      if (key.return) props.onAnswer(buffer());
      else setBuffer((b) => applyTextKey(b, input, key));
      return;
    }
    const count = items().length;
    if (count === 0) return;
    if (request.kind === 'confirm' && !key.ctrl && !key.meta) {
      // y/n 直达:确认框不该逼人用方向键。
      if (input === 'y' || input === 'Y') {
        props.onAnswer(true);
        return;
      }
      if (input === 'n' || input === 'N') {
        props.onAnswer(false);
        return;
      }
    }
    if (key.upArrow) {
      setCursor((c) => (c - 1 + count) % count);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % count);
      return;
    }
    if (key.return) submit(cursor());
  });

  const windowStart = createMemo(() => centeredWindowStart(cursor(), items().length, WINDOW));
  const visible = createMemo(() => items().slice(windowStart(), windowStart() + WINDOW));
  const hint = (): string => {
    const kind = props.request.kind;
    return kind === 'input'
      ? t('uiPrompt.inputHint')
      : kind === 'confirm'
        ? t('uiPrompt.confirmHint')
        : t('uiPrompt.selectHint');
  };

  return (
    // 不设 marginTop:与时间线的分隔由 App 底部固定区的外层容器统一给出。
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text bold color={theme.accent} wrap="truncate-end">
          {props.request.title}
        </Text>
        <Show when={props.request.kind === 'confirm' ? props.request.message : undefined}>
          {(message: () => string) => <Text wrap="wrap">{message()}</Text>}
        </Show>
        <Show when={props.request.kind === 'input'}>
          <Text>
            <Text color={theme.accent}>{`${glyphs.pointer} `}</Text>
            <Show
              when={buffer()}
              fallback={
                <Text color={theme.dim}>
                  {props.request.kind === 'input' ? (props.request.placeholder ?? '') : ''}
                </Text>
              }
            >
              {buffer()}
            </Show>
            <Text color={theme.accent}>▏</Text>
          </Text>
        </Show>
        <Show when={windowStart() > 0}>
          <Text color={theme.dim}>{t('selector.moreAbove', { n: windowStart() })}</Text>
        </Show>
        <For each={visible()}>
          {(item, i) => {
            const index = () => windowStart() + i();
            const active = () => index() === cursor();
            return (
              // 点击即选中该项(等价于把光标移过去再回车)。
              <Text
                color={active() ? theme.accent : undefined}
                wrap="truncate-end"
                onClick={() => {
                  setCursor(index());
                  submit(index());
                }}
              >
                {active() ? `${glyphs.pointer} ` : '  '}
                {item}
              </Text>
            );
          }}
        </For>
        <Show when={windowStart() + WINDOW < items().length}>
          <Text color={theme.dim}>
            {t('selector.moreBelow', { n: items().length - windowStart() - WINDOW })}
          </Text>
        </Show>
      </Box>
      <Box paddingLeft={2}>
        <Text color={theme.dim}>{hint()}</Text>
      </Box>
    </Box>
  );
}
