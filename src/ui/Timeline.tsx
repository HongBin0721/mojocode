import { For, Show } from 'solid-js';
import { Box, Text, type JSX } from './kit.js';
import { Diff } from './Diff.js';
import { Header } from './Header.js';
import { renderMarkdownCached } from './md-cache.js';
import {
  theme,
  glyphs,
  formatDuration,
  formatTokens,
  formatToolInput,
  toolDisplayName,
  truncateWidth,
  WIDTH_SAFETY,
} from './theme.js';
import { extractDiff, extractPlan, extractTodos } from './timeline-data.js';
import type { TimelineItem } from './types.js';
import type { TodoItem } from '../tools/todo.js';
import { t } from '../i18n/index.js';

/**
 * 一条已完成的时间线条目。挂在 scrollbox 里。
 *
 * 性能模型与 React 时代不同:Solid 细粒度响应式下,条目组件只在创建时
 * 运行一次(item 定稿后不可变,App 的 <For> 按引用复用),React.memo 的
 * 等价物是免费的。宽度变化经 props.columns 的 JSX 内联访问触达 markdown
 * 重排;renderMarkdownAnsi 仍按 (key, width) 走 LRU 缓存(md-cache.ts),
 * resize 来回摆动不重复渲染。
 */
export function TimelineEntry(props: {
  item: TimelineItem;
  columns: number;
  /** ctrl+r 的全局详情开关:思考正文与工具输出跟着它展开/收起。 */
  expanded?: boolean;
}): JSX.Element {
  // item 定稿后不可变(App 只整条替换,从不原位修改),按创建时的值分支。
  const item = props.item;
  switch (item.kind) {
    case 'user':
      // 用户消息用高亮色,和 agent 的白色回复、灰色思考区分开;回看时靠
      // 行首的 > 提示符加这一抹颜色定位自己问了什么。
      //
      // 版式与 assistant 同构:提示符单独占一列,正文进 flexGrow 的列容器,
      // 折行才会挂在提示符右侧对齐。整段塞一个 Text 的话,第二行会顶到第 0
      // 列,和首行错开(与 opencode 对比时实测到的)。
      return (
        <Box marginTop={1}>
          <Text color={theme.user}>{'> '}</Text>
          <Box flexDirection="column" flexGrow={1} paddingRight={WIDTH_SAFETY}>
            <Text color={theme.user}>{item.text}</Text>
          </Box>
        </Box>
      );

    case 'assistant':
      // 定稿消息用 marked 完整渲染(表格/代码高亮);● 前缀占 2 列,宽度相应
      // 收窄。增量提交的后续片段不重复画 ●,只缩进对齐。
      return (
        <Box marginTop={1}>
          <Text color={theme.assistant}>{item.continuation ? '  ' : `${glyphs.bullet} `}</Text>
          <Box flexDirection="column" flexGrow={1}>
            {/* 前缀 2 列 + WIDTH_SAFETY 边距:与流式预览同宽,定稿前后折行一致。 */}
            <Text>{renderMarkdownCached(item.key, item.text, props.columns - 2 - WIDTH_SAFETY)}</Text>
          </Box>
        </Box>
      );

    case 'reasoning': {
      // 默认只留一行痕迹:思考正文在流式期间已经实时显示过,定稿再摊开一遍
      // 既是重复,又会把回复和工具记录挤出屏幕(见 types.ts 的说明)。
      // 耗时从历史回放不出来,那时只写"已思考"。ctrl+r 展开时才摊开正文,
      // 行尾的 +/- 是这件事的唯一提示。
      const label = item.durationMs
        ? t('ui.thoughtFor', { duration: formatDuration(item.durationMs) })
        : t('ui.thought');
      const hasText = Boolean(item.text.trim());
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.dim} italic>
            {/* 标记在行首(与 opencode 的 `+ Thought` 同位):跟在耗时后面时,
                没有耗时的历史条目会读成"已思考 -"。没有正文可展开时空占两列,
                若干条思考之间不会错位。 */}
            {hasText ? `${props.expanded ? glyphs.expanded : glyphs.expandable} ` : '  '}
            {glyphs.thinking} {label}
          </Text>
          <Show when={hasText && props.expanded}>
            <Box paddingLeft={4} paddingRight={WIDTH_SAFETY}>
              <Text color={theme.dim} italic>
                {item.text.trim()}
              </Text>
            </Box>
          </Show>
        </Box>
      );
    }

    case 'turn':
      // 一轮的收尾行:模型 · 耗时 · 本轮 token。底栏给的是"此刻"的累计值,
      // 回看历史时无从知道某一轮花了多少——这一行补的正是这个。
      return (
        <Box marginTop={1}>
          <Text color={theme.dim}>
            {glyphs.turn} {item.model} · {formatDuration(item.durationMs)} ·{' '}
            {t('ui.turnTokens', { n: formatTokens(item.tokens) })}
          </Text>
        </Box>
      );

    case 'tool':
      return <ToolEntry item={item} columns={props.columns} expanded={props.expanded} />;

    case 'notice':
      return (
        <Box marginTop={1}>
          <Text color={item.level === 'warn' ? theme.warn : theme.dim}>
            {item.level === 'warn' ? '! ' : '· '}
            {item.message}
          </Text>
        </Box>
      );

    case 'error':
      return (
        <Box marginTop={1}>
          <Text color={theme.error}>
            {glyphs.failed} {item.message}
          </Text>
        </Box>
      );

    case 'divider':
      return (
        <Box marginTop={1}>
          <Text color={theme.dim}>── {item.label} ──</Text>
        </Box>
      );

    case 'collapsed':
      // /focus compact 档:一段被折叠的工具调用的占位行。
      return (
        <Box marginTop={1}>
          <Text color={theme.dim}>⋯ {t('ui.collapsedTools', { n: item.count })}</Text>
        </Box>
      );

    case 'banner':
      // 永远是时间线第一条(启动/清屏后紧贴屏幕顶部),不加 marginTop。
      return (
        <Header
          providerLabel={item.providerLabel}
          model={item.model}
          root={item.root}
          mode={item.mode}
          mcpSummary={item.mcpSummary}
          columns={props.columns}
        />
      );

    default:
      return null;
  }
}

function ToolEntry(props: {
  item: Extract<TimelineItem, { kind: 'tool' }>;
  columns: number;
  expanded?: boolean;
}): JSX.Element {
  const item = props.item; // 定稿数据,不可变
  const args = formatToolInput(item.toolName, item.input);
  const diff = extractDiff(item);
  const todos = extractTodos(item);
  const plan = extractPlan(item);

  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={item.isError ? theme.error : theme.success}>{glyphs.bullet} </Text>
        <Text bold>{toolDisplayName(item.toolName)}</Text>
        {args ? <Text color={theme.dim}>({truncateWidth(args, 100)})</Text> : null}
      </Box>
      {todos ? (
        <TodoChecklist todos={todos} />
      ) : plan ? (
        // 方案完整展开,后面再跟一行批准结果。渲染结果按条目缓存(见文件头)。
        <Box paddingLeft={2} flexDirection="column">
          <Text>{renderMarkdownCached(`${item.key}:plan`, plan, props.columns - 2 - WIDTH_SAFETY)}</Text>
          <Box>
            <Text color={theme.dim}>{glyphs.branch}  </Text>
            <Text color={item.isError ? theme.error : theme.dim}>{item.summary}</Text>
          </Box>
        </Box>
      ) : (
        <Box paddingLeft={2}>
          <Text color={theme.dim}>{glyphs.branch}  </Text>
          <Text color={item.isError ? theme.error : theme.dim}>
            {truncateWidth(item.summary, 160)}
            {/* bash 已经在摘要里报告了自己的耗时。 */}
            {!item.isError && item.toolName !== 'bash' && item.durationMs > 1500
              ? ` · ${formatDuration(item.durationMs)}`
              : ''}
          </Text>
        </Box>
      )}
      {diff ? (
        <Box paddingLeft={5} flexDirection="column">
          <Diff patch={diff} maxLines={24} />
        </Box>
      ) : null}
      {item.toolName === 'bash' && !item.isError ? (
        <BashOutput output={item.output} expanded={props.expanded} />
      ) : null}
    </Box>
  );
}

/**
 * todo 工具直接展开任务清单(Claude Code 风格),比"3 tasks"摘要直观:
 * 已完成的画勾 + 删除线,进行中的用强调色标出。
 */
function TodoChecklist(props: { todos: TodoItem[] }): JSX.Element {
  return (
    <Box paddingLeft={2} flexDirection="column">
      <For each={props.todos}>
        {(todo, index) => (
          <Box>
            <Text color={theme.dim}>{index() === 0 ? `${glyphs.branch}  ` : '   '}</Text>
            {todo.status === 'completed' ? (
              <Text color={theme.dim} strikethrough>
                {glyphs.checked} {todo.content}
              </Text>
            ) : todo.status === 'in_progress' ? (
              <Text color={theme.accent}>
                {glyphs.unchecked} {todo.content}
              </Text>
            ) : (
              <Text>
                {glyphs.unchecked} {todo.content}
              </Text>
            )}
          </Box>
        )}
      </For>
    </Box>
  );
}

/** 展开时最多摊开的输出行数——再多就该去看终端本身了。 */
const EXPANDED_OUTPUT_LINES = 200;

/**
 * 工具的原始输出(目前只有 bash 有正文)。**默认全折叠**,只留一行
 * 「+ N 行输出」占位,ctrl+r 展开。
 *
 * 折叠是默认值而不是选项:一条 `ls -la` 就能把回复顶出视口,而摘要行
 * (退出码 · 耗时)已经回答了"跑成功没有"。真要看内容的时候才展开——
 * 与 opencode 的取舍一致。diff、方案正文、任务清单不在此列:它们是结果
 * 不是过程(同 focus.ts 的划线)。
 */
function BashOutput(props: { output: unknown; expanded?: boolean }): JSX.Element {
  const text = (props.output as { output?: unknown } | undefined)?.output;
  if (typeof text !== 'string' || !text.trim() || text === '(no output)') return null;

  const lines = text.split('\n');
  const shown = () => lines.slice(0, EXPANDED_OUTPUT_LINES);
  const hidden = () => lines.length - shown().length;

  return (
    <Box paddingLeft={5} flexDirection="column">
      <Show
        when={props.expanded}
        fallback={
          <Text color={theme.dim}>
            {glyphs.expandable} {t('ui.outputLines', { n: lines.length })}
          </Text>
        }
      >
        <For each={shown()}>{(line) => <Text color={theme.dim}>{line.slice(0, 200) || ' '}</Text>}</For>
        <Show when={hidden() > 0}>
          <Text color={theme.dim}>{t('ui.moreLines', { n: hidden() })}</Text>
        </Show>
      </Show>
    </Box>
  );
}
