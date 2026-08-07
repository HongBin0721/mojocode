import React from 'react';
import { Box, Text } from './kit.js';
import { Diff } from './Diff.js';
import { Header } from './Header.js';
import { renderMarkdownCached } from './md-cache.js';
import {
  theme,
  glyphs,
  formatDuration,
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
 * 一条已完成的时间线条目。挂在 scrollbox 里,App 每次状态变化都会走到
 * 这里——性能靠两层防线:React.memo(条目对象定稿后引用不变,宽度不变
 * 即跳过重渲染)+ markdown 渲染按 (key, width) 缓存(md-cache.ts),
 * 这正是长会话不会越来越卡的原因。
 */
export const TimelineEntry = React.memo(function TimelineEntry({
  item,
  columns,
}: {
  item: TimelineItem;
  /** 终端宽度。从 App 统一下发,替代原来的 process.stdout.columns 直读。 */
  columns: number;
}): React.ReactElement | null {
  switch (item.kind) {
    case 'user':
      // 用户消息用高亮色,和 agent 的白色回复、灰色思考区分开;回看时靠
      // 行首的 > 提示符加这一抹颜色定位自己问了什么。
      return (
        <Box marginTop={1}>
          <Text color={theme.user}>{`> ${item.text}`}</Text>
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
            <Text>{renderMarkdownCached(item.key, item.text, columns - 2 - WIDTH_SAFETY)}</Text>
          </Box>
        </Box>
      );

    case 'reasoning':
      // 只留一行痕迹:思考正文在流式期间已经实时显示过,定稿再摊开一遍
      // 既是重复,又会把回复和工具记录挤出屏幕(见 types.ts 的说明)。
      // 耗时从历史回放不出来,那时只写"已思考"。
      return (
        <Box marginTop={1}>
          <Text color={theme.dim} italic>
            {glyphs.thinking}{' '}
            {item.durationMs
              ? t('ui.thoughtFor', { duration: formatDuration(item.durationMs) })
              : t('ui.thought')}
          </Text>
        </Box>
      );

    case 'tool':
      return <ToolEntry item={item} columns={columns} />;

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
        />
      );

    default:
      return null;
  }
});

function ToolEntry({
  item,
  columns,
}: {
  item: Extract<TimelineItem, { kind: 'tool' }>;
  columns: number;
}) {
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
          <Text>{renderMarkdownCached(`${item.key}:plan`, plan, columns - 2 - WIDTH_SAFETY)}</Text>
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
        <BashOutput output={item.output} />
      ) : null}
    </Box>
  );
}

/**
 * todo 工具直接展开任务清单(Claude Code 风格),比"3 tasks"摘要直观:
 * 已完成的画勾 + 删除线,进行中的用强调色标出。
 */
function TodoChecklist({ todos }: { todos: TodoItem[] }) {
  return (
    <Box paddingLeft={2} flexDirection="column">
      {todos.map((todo, index) => (
        <Box key={index}>
          <Text color={theme.dim}>{index === 0 ? `${glyphs.branch}  ` : '   '}</Text>
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
      ))}
    </Box>
  );
}

function BashOutput({ output }: { output: unknown }) {
  const text = (output as { output?: unknown } | undefined)?.output;
  if (typeof text !== 'string' || !text.trim() || text === '(no output)') return null;

  const lines = text.split('\n');
  const shown = lines.slice(0, 12);
  const hidden = lines.length - shown.length;

  return (
    <Box paddingLeft={5} flexDirection="column">
      {shown.map((line, index) => (
        <Text key={index} color={theme.dim}>
          {line.slice(0, 200) || ' '}
        </Text>
      ))}
      {hidden > 0 && <Text color={theme.dim}>{t('ui.moreLines', { n: hidden })}</Text>}
    </Box>
  );
}
