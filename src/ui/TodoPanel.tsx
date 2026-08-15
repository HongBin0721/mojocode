import { createMemo, For } from 'solid-js';
import { Box, Text, type JSX } from './kit.js';
import { theme, glyphs, truncateWidth, WIDTH_SAFETY } from './theme.js';
import type { TodoItem } from '../tools/todo.js';
import { t } from '../i18n/index.js';

/**
 * 工作期间挂在状态行下方的实时任务清单(Claude Code 的 ctrl+t 面板)。
 * 处于动态渲染区,每行都必须截断到单行以内(见 WIDTH_SAFETY),行数
 * 也要有硬上限——超长清单把已完成项折叠成一行、尾部溢出折叠成 "… 还有
 * n 项",总高度不超过 MAX_TODO_ROWS。
 */
export const MAX_TODO_ROWS = 6;

/** 面板的一行:折叠的已完成汇总 / 具体任务 / 尾部溢出提示。 */
type PanelRow =
  | { kind: 'done-collapsed'; n: number }
  | { kind: 'todo'; todo: TodoItem }
  | { kind: 'overflow'; n: number };

/** 布局计算独立成纯函数:App 需要在渲染前拿到行数来扣预览高度预算。 */
export function todoPanelRows(todos: TodoItem[]): PanelRow[] {
  if (todos.length <= MAX_TODO_ROWS) {
    return todos.map((todo) => ({ kind: 'todo', todo }));
  }
  const done = todos.filter((todo) => todo.status === 'completed');
  // 进行中的排在待办之前:超长清单要截断时,先被砍掉的必须是靠后的待办,
  // 而不是"当前正在做什么"——那正是这个面板存在的理由。按位置截的话,
  // 一份前面排着一堆 pending 的清单会把 in_progress 那项挤掉。
  const running = todos.filter((todo) => todo.status === 'in_progress');
  const pending = todos.filter((todo) => todo.status === 'pending');
  const rest = [...running, ...pending];

  const rows: PanelRow[] = [];
  if (done.length > 0) rows.push({ kind: 'done-collapsed', n: done.length });
  const avail = MAX_TODO_ROWS - rows.length;
  if (rest.length > avail) {
    for (const todo of rest.slice(0, avail - 1)) rows.push({ kind: 'todo', todo });
    rows.push({ kind: 'overflow', n: rest.length - (avail - 1) });
  } else {
    for (const todo of rest) rows.push({ kind: 'todo', todo });
  }
  return rows;
}

export function TodoPanel(props: { todos: TodoItem[]; columns: number }): JSX.Element {
  const rows = createMemo(() => todoPanelRows(props.todos));
  // 前缀 "⎿  "/对齐 3 列 + 复选框 2 列 + 边距。
  const width = () => Math.max(20, props.columns - WIDTH_SAFETY - 5 - 2);

  return (
    // marginBottom:面板与正下方的输入框隔一行;与时间线的间距归外层底部
    // 固定区统一给出,这里不重复叠。
    <Box paddingLeft={2} flexDirection="column" marginBottom={1}>
      {/* For 按引用重建:rows() 每次整体重算出新对象,行组件随之整体重建,
          PanelRowText 在组件体里读 props 因此安全(没有原位更新)。 */}
      <For each={rows()}>
        {(row, index) => (
          <Box>
            <Text color={theme.dim}>{index() === 0 ? `${glyphs.branch}  ` : '   '}</Text>
            <PanelRowText row={row} width={width()} />
          </Box>
        )}
      </For>
    </Box>
  );
}

function PanelRowText(props: { row: PanelRow; width: number }): JSX.Element {
  // row 变体是静态数据(rows() 每次整体重建),body 里分支即可。
  const row = props.row;
  switch (row.kind) {
    case 'done-collapsed':
      return (
        <Text color={theme.dim}>
          {glyphs.checked} {t('ui.todoDone', { n: row.n })}
        </Text>
      );
    case 'overflow':
      return <Text color={theme.dim}>{t('ui.moreTodos', { n: row.n })}</Text>;
    default: {
      const text = truncateWidth(row.todo.content, props.width);
      if (row.todo.status === 'completed') {
        return (
          <Text color={theme.dim} strikethrough>
            {glyphs.checked} {text}
          </Text>
        );
      }
      if (row.todo.status === 'in_progress') {
        return (
          <Text color={theme.accent}>
            {glyphs.unchecked} {text}
          </Text>
        );
      }
      return (
        <Text>
          {glyphs.unchecked} {text}
        </Text>
      );
    }
  }
}
