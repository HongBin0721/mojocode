import { createMemo, createSignal, For, Show } from 'solid-js';
import { Box, Text, useInput, type JSX } from './kit.js';
import { theme, glyphs } from './theme.js';
import { t } from '../i18n/index.js';
import { centeredWindowStart } from './picker-utils.js';

const WINDOW = 8;

export interface ReviewPickerRow {
  /** 提交给 startReview 的值(分支名或短 sha)。 */
  value: string;
  /** 行首的醒目段:分支名或短 sha。 */
  head: string;
  /** 随后的灰色说明:该分支/提交的最新提交标题(提交行再带相对时间)。 */
  detail: string;
}

interface Props {
  title: string;
  rows: ReviewPickerRow[];
  onPick: (value: string) => void;
  onCancel: () => void;
}

/**
 * `/review` 选完预设后的第二级选择器(基准分支 / 提交)。与 RewindPicker 同
 * 一形态:渲染期间 Input 已卸载(App 的渲染分支互斥),自带的 useInput 不与
 * 输入框抢按键;点击一行等价于移光标再回车。
 */
export function ReviewPicker(props: Props): JSX.Element {
  const [cursor, setCursor] = createSignal(0);

  useInput((_input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => (c - 1 + props.rows.length) % props.rows.length);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % props.rows.length);
      return;
    }
    if (key.return) {
      const row = props.rows[cursor()];
      if (row) props.onPick(row.value);
    }
  });

  const windowStart = createMemo(() => centeredWindowStart(cursor(), props.rows.length, WINDOW));
  const visible = createMemo(() => props.rows.slice(windowStart(), windowStart() + WINDOW));

  return (
    // 不设 marginTop:与时间线的分隔由 App 底部固定区的外层容器统一给出。
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text bold color={theme.accent}>
          {props.title}
        </Text>
        <Show when={windowStart() > 0}>
          <Text color={theme.dim}>{t('selector.moreAbove', { n: windowStart() })}</Text>
        </Show>
        <For each={visible()}>
          {(row, i) => {
            const active = () => windowStart() + i() === cursor();
            return (
              // 整行一个颜色:选中 accent、未选 dim(Codex 式)。head/detail 必须是
              // 外层 Text 的直接字符串子节点——嵌套 <Text> 变 span 后 color
              // undefined 不继承外层 accent(fg 落回默认白),选中行会看不出
              // 高亮(踩过的坑,别再包一层)。
              <Text
                color={active() ? theme.accent : theme.dim}
                wrap="truncate-end"
                onClick={() => props.onPick(row.value)}
              >
                {active() ? `${glyphs.pointer} ` : '  '}
                {row.head}
                {row.detail ? ` ${row.detail}` : ''}
              </Text>
            );
          }}
        </For>
        <Show when={windowStart() + WINDOW < props.rows.length}>
          <Text color={theme.dim}>
            {t('selector.moreBelow', { n: props.rows.length - windowStart() - WINDOW })}
          </Text>
        </Show>
      </Box>
      <Box paddingLeft={2}>
        <Text color={theme.dim}>{t('selector.hint')}</Text>
      </Box>
    </Box>
  );
}
