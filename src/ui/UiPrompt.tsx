import { createMemo, createSignal, For, Show } from 'solid-js';
import { Box, Text, useInput, type JSX } from './kit.js';
import type { UiAnswer, UiRequest } from '../core/extension-types.js';
import { theme, glyphs } from './theme.js';
import { t } from '../i18n/index.js';
import { applyTextKey, centeredWindowStart } from './picker-utils.js';

const WINDOW = 8;

interface Props {
  request: UiRequest;
  /** select:选中项或 undefined(esc);confirm:布尔;input / editor:文本或 undefined(esc)。 */
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
  const [buffer, setBuffer] = createSignal(
    props.request.kind === 'editor' ? (props.request.prefill ?? '') : '',
  );

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
    if (request.kind === 'input' || request.kind === 'editor') {
      // 两种文本框只差一个 multiline:打字/退格/粘贴的语义与手动输入态、
      // 扩展的 textInput 同一份实现;多行的换行约定与主输入框一致——
      // 行尾 `\` + 回车换行,回车提交。
      const multiline = request.kind === 'editor';
      if (key.return) {
        if (multiline && buffer().endsWith('\\')) setBuffer((b) => `${b.slice(0, -1)}\n`);
        else props.onAnswer(buffer());
      } else {
        setBuffer((b) => applyTextKey(b, input, key, { multiline }));
      }
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

  /** 多行框的行。**一个 memo**:每行再 split 一次整段 buffer 只为问"我是不是最后一行",
      粘进来 60 行就是每次按键把整段扫 61 遍。 */
  const bufferLines = createMemo(() => buffer().split('\n'));
  const windowStart = createMemo(() => centeredWindowStart(cursor(), items().length, WINDOW));
  const visible = createMemo(() => items().slice(windowStart(), windowStart() + WINDOW));
  const hint = (): string => {
    const kind = props.request.kind;
    return kind === 'input'
      ? t('uiPrompt.inputHint')
      : kind === 'editor'
        ? t('uiPrompt.editorHint')
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
        <Show when={props.request.kind === 'editor'}>
          <Box flexDirection="column">
            <For each={bufferLines()}>
              {(line, i) => (
                <Text>
                  <Text color={theme.accent}>{i() === 0 ? `${glyphs.pointer} ` : '  '}</Text>
                  {line}
                  {i() === bufferLines().length - 1 ? <Text color={theme.accent}>▏</Text> : null}
                </Text>
              )}
            </For>
          </Box>
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
