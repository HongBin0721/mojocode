import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { Box, Text, type JSX } from './kit.js';
import { theme, truncateWidth, WIDTH_SAFETY } from './theme.js';
import { formatElapsed } from './timeline-data.js';
import type { ExtensionStatusEntry } from '../core/extension.js';

interface Props {
  /**
   * 现取而不是收一份 props 里的值:条目有 since 时已用时一直在变,而扩展
   * 循环两轮之间 App 未必有任何信号变化。这个组件自己按秒 tick,每次现读。
   */
  entries: () => ExtensionStatusEntry[];
  /** 终端宽度,用于截断——理由见下方注释。 */
  columns: number;
}

/**
 * 输入框正上方靠右的一行扩展状态,如 `◎ 目标 3/10 · 1m04s`。多个扩展的条目
 * 拼在同一行(App 的高度预算只给这里留了一行);带 since 的条目由本组件
 * 追加已用时——扩展只报一次起点,不必每秒推一帧状态。
 *
 * 单独占一行而不是挤进 StatusLine:StatusLine 只在有工作状态时渲染,而
 * 「目标待续」这类状态恰恰是空闲时更需要提醒;状态行本身也已经带了阶段、
 * 秒数和 esc 提示,窄终端下再往里塞就要折行了。
 */
export function ExtensionStatusLine(props: Props): JSX.Element {
  const [tick, setTick] = createSignal(0);
  /**
   * 秒表只在**真有带 since 的条目**时走。渲染层其余部分是按需重绘的,常驻
   * 一个每秒信号会让空闲的 TUI 每秒重算一遍(绝大多数会话根本没有扩展状态
   * 行)。它替代的 GoalLine 只在目标激活时才挂载,这里靠 effect 补回来。
   */
  createEffect(() => {
    if (!props.entries().some((entry) => entry.since !== undefined)) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    onCleanup(() => clearInterval(timer));
  });

  const label = createMemo(() => {
    tick(); // 秒表驱动重读
    const entries = props.entries();
    if (entries.length === 0) return undefined;
    const now = Date.now();
    return entries
      .map((entry) =>
        entry.since === undefined ? entry.text : `${entry.text} · ${formatElapsed(now - entry.since)}`,
      )
      .join('  ');
  });

  return (
    <Show when={label() !== undefined}>
      <Box justifyContent="flex-end" paddingRight={WIDTH_SAFETY}>
        {/* 必须截断:文案可能有 40 多列,窄终端下会折成两行,而 App 的高度
            预算只给这里留了一行,动态区就会比记账多出一行。 */}
        <Text color={theme.dim}>{truncateWidth(label()!, Math.max(8, props.columns - WIDTH_SAFETY))}</Text>
      </Box>
    </Show>
  );
}
