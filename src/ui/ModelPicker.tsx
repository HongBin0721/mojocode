import { createMemo, createSignal, For, Show } from 'solid-js';
import { Box, Text, useInput, type JSX } from './kit.js';
import { theme, glyphs, formatTokens } from './theme.js';
import { t } from '../i18n/index.js';
import { centeredWindowStart, createManualEntry, ManualEntryBox } from './picker-utils.js';

const WINDOW = 8;

/** 一行模型。note 是右侧的灰色标注(如上下文窗口)。 */
export interface ModelOption {
  id: string;
  note?: string;
}

/** 上下文窗口换算成选择器行尾的标注(256k / 1.0M)。 */
export function contextNote(window: number | undefined): string | undefined {
  return window === undefined ? undefined : t('modelpicker.context', { n: formatTokens(window) });
}

interface Props {
  title: string;
  models: ModelOption[];
  /** 光标初值——向导里落在预设的默认模型上。 */
  initial?: string;
  /** 允许手动输入 id:底部多一行,选中后进入内嵌输入态。端点不提供模型列表时的兜底。 */
  allowManual?: boolean;
  onPick: (id: string) => void;
  onCancel: () => void;
}

/**
 * 模型选择器(向导专用,`/models` 用的是分组的 ModelsPicker)。结构对齐
 * RewindPicker:窗口化列表、↑/↓/回车/esc、点击即选定;它渲染期间 Input
 * 已卸载,自带的 useInput 不会与输入框抢按键。
 *
 * 手动输入行(allowManual)是为"端点不提供 /models 列表"的场景准备的
 * (部分订阅端点如此,doctor 有同场景提示):选中后在本组件内切到一个
 * 单行输入框,回车即视作选定该 id。
 */
export function ModelPicker(props: Props): JSX.Element {
  const [cursor, setCursor] = createSignal(
    Math.max(
      0,
      props.models.findIndex((m) => m.id === props.initial),
    ),
  );
  const manual = createManualEntry((id) => props.onPick(id));

  /** 手动输入行也算一行,窗口滚动要把它含在内。 */
  const rowCount = () => props.models.length + (props.allowManual ? 1 : 0);

  useInput((input, key) => {
    if (manual.handleKey(input, key)) return;
    if (key.escape) {
      props.onCancel();
      return;
    }
    const total = rowCount();
    if (total === 0) return;
    if (key.upArrow) {
      setCursor((c) => (c + total - 1) % total);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % total);
      return;
    }
    if (key.return) {
      if (props.allowManual && cursor() === props.models.length) {
        manual.openEntry();
        return;
      }
      const option = props.models[cursor()];
      if (option) props.onPick(option.id);
    }
  });

  const windowStart = createMemo(() => centeredWindowStart(cursor(), rowCount(), WINDOW));
  const slice = createMemo(() => {
    const end = windowStart() + WINDOW;
    return { from: windowStart(), to: Math.min(end, props.models.length) };
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text bold color={theme.accent}>
          {props.title}
        </Text>
        <Show when={slice().from > 0}>
          <Text color={theme.dim}>{t('selector.moreAbove', { n: slice().from })}</Text>
        </Show>
        <For each={props.models.slice(slice().from, slice().to)}>
          {(option, i) => {
            const index = () => slice().from + i();
            const active = () => index() === cursor();
            return (
              // 点击即选定该模型(等价于把光标移过去再回车)。
              <Text
                color={active() ? theme.accent : undefined}
                wrap="truncate-end"
                onClick={() => props.onPick(option.id)}
              >
                {active() ? `${glyphs.pointer} ` : '  '}
                {option.id}
                <Show when={option.note}>
                  <Text color={theme.dim}> — {option.note}</Text>
                </Show>
              </Text>
            );
          }}
        </For>
        {/* 手动输入行永远垫底:窗口滚到末尾才露面,与 moreBelow 的计数一致。 */}
        <Show when={props.allowManual && windowStart() + WINDOW >= rowCount()}>
          <Text
            color={cursor() === props.models.length ? theme.accent : theme.dim}
            wrap="truncate-end"
            onClick={() => manual.openEntry()}
          >
            {cursor() === props.models.length ? `${glyphs.pointer} ` : '  '}
            {glyphs.prompt} {t('modelpicker.manual')}
          </Text>
        </Show>
        <Show when={manual.open()}>
          <ManualEntryBox buffer={manual.buffer()} />
        </Show>
        <Show when={windowStart() + WINDOW < rowCount()}>
          <Text color={theme.dim}>
            {t('selector.moreBelow', { n: rowCount() - windowStart() - WINDOW })}
          </Text>
        </Show>
      </Box>
      <Box paddingLeft={2}>
        <Text color={theme.dim}>{t('selector.hint')}</Text>
      </Box>
    </Box>
  );
}
