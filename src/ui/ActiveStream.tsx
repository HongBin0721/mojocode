import { For, Show } from 'solid-js';
import { Box, Text, type JSX } from './kit.js';
import { Markdown } from './Markdown.js';
import {
  theme,
  glyphs,
  formatToolInput,
  toolDisplayName,
  truncateWidth,
  WIDTH_SAFETY,
} from './theme.js';
import { tailWithinRows } from './preview.js';
import { t } from '../i18n/index.js';
import { REASONING_PREVIEW_ROWS } from './commands/registry.js';
import type { ActiveToolCall } from './types.js';
import type { TaskProgressEntry } from './timeline-controller.js';

/**
 * 时间线尾部的动态区(opencode 式,原 App.tsx body 里的一段,整段搬运):
 * 流式思考尾部/正文/进行中的工具行挂在 scrollbox 尾部原地生长,粘底自动
 * 跟随,上滚即可回看已生成的部分——正文不再裁剪,长代码块也完整可见。
 * 定稿(text-end/段落提交)时活动条目原位换成不可变条目,版式与前缀完全
 * 一致,肉眼无跳变。
 *
 * props 全部是 getter(信号读取留在组件的响应式作用域里,不在 App 侧求值)。
 */
export interface ActiveStreamProps {
  activeReasoning: () => string;
  activeText: () => string;
  textCommitted: () => boolean;
  activeTools: () => ActiveToolCall[];
  taskProgress: () => Record<string, TaskProgressEntry>;
  /** 终端列数(getter)。 */
  columns: () => number;
  /** 终端行数(getter),流式正文尾部窗口按它打预算。 */
  rows: () => number;
}

// 思考尾部窗口不再需要按终端高度打预算:活动区已并入时间线 scrollbox,
// 矮终端上被压缩的是滚动视口,底部固定区(输入框/状态栏)天然保得住。

/**
 * 流式正文的可见尾部。段落提交(splitCommitted)通常把可变区压得很小,
 * 但**代码围栏里没有切点**——模型写一个 500 行的文件时整块都留在
 * activeText 里,而 Markdown.tsx 每个 delta 都重建全部行的 `<Text>`
 * (定稿路径有 md-cache,这里没有),成本 O(已生成行数) → 随块长二次增长,
 * 还要让整个 scrollbox 重新布局:长代码输出到一半就能明显感到按键延迟。
 *
 * 所以给可变区一个**宽松**上限:三屏(至少 60 行)。日常段落与中等代码块
 * 远在其内,完整可见(这正是并入时间线要的效果);只有超长块会在流式期间
 * 只显示尾部,text-end 定稿后立刻全量可见。
 */
export function ActiveStream(props: ActiveStreamProps): JSX.Element {
  const streamTailRows = () => Math.max(60, props.rows() * 3);
  const activeStreamText = () =>
    tailWithinRows(props.activeText().trimEnd(), streamTailRows(), props.columns() - 2 - WIDTH_SAFETY);

  return (
    <>
      <Show when={props.activeReasoning().trim()}>
        <Box marginTop={1} paddingRight={WIDTH_SAFETY}>
          {/* markdown: false——这里是纯 <Text> 渲染,按 Markdown.tsx 的变换
              估算会系统性高估,窗口高度随之来回摆。窗口高度被钉死在
              REASONING_PREVIEW_ROWS 行,上方时间线在整段思考期间纹丝不动。 */}
          <Text color={theme.dim} italic>
            {tailWithinRows(props.activeReasoning(), REASONING_PREVIEW_ROWS, props.columns() - WIDTH_SAFETY, {
              markdown: false,
            })}
          </Text>
        </Box>
      </Show>

      <Show when={props.activeText().trim()}>
        <Box marginTop={1}>
          {/* 与定稿的 assistant 条目同构:首段带 ●,增量提交后的续段只缩进。 */}
          <Text color={theme.assistant}>{props.textCommitted() ? '  ' : `${glyphs.bullet} `}</Text>
          <Box flexDirection="column" flexGrow={1} paddingRight={WIDTH_SAFETY}>
            <Markdown text={activeStreamText()} />
          </Box>
        </Box>
      </Show>

      <For each={props.activeTools()}>
        {(call) => {
          const label = toolDisplayName(call.toolName);
          // 子 agent 的实时进度:顶行贴步数,下面缩进画最近几条工具调用的
          // 轨迹。轨迹只存在于动态区,任务收尾即消失——过程随时看得见,
          // 时间线(回滚缓冲)仍然只留一行摘要。
          const progress = () => props.taskProgress()[call.callId];
          const trail = () => progress()?.recentCalls ?? [];
          // 顶行只报步数:正在跑的工具就是轨迹的末条,再写一遍是重复。
          // (事件里仍带 currentTool,给 --json 的消费方用。)
          const progressText = () =>
            progress() ? ` · ${t('ui.taskSteps', { n: progress()!.steps })}` : '';
          // 前缀 2 列 + 工具名 + 括号 2 列,截到单行以内。
          const args = () =>
            truncateWidth(
              formatToolInput(call.toolName, call.input),
              Math.max(20, props.columns() - WIDTH_SAFETY - label.length - 6 - progressText().length),
            );
          return (
            <Box marginTop={1} flexDirection="column" paddingRight={WIDTH_SAFETY}>
              <Box>
                <Text color={theme.tool}>{glyphs.running} </Text>
                <Text bold>{label}</Text>
                {/* 无参数的工具(todo)不画空括号,与时间线、headless 一致。 */}
                <Show when={args()}>
                  <Text color={theme.dim}>({args()})</Text>
                </Show>
                <Show when={progressText()}>
                  <Text color={theme.dim}>{progressText()}</Text>
                </Show>
              </Box>
              <For each={trail()}>
                {(sub) => {
                  const subLabel = toolDisplayName(sub.toolName);
                  const subArgs = () =>
                    truncateWidth(
                      formatToolInput(sub.toolName, sub.input),
                      Math.max(20, props.columns() - WIDTH_SAFETY - subLabel.length - 10),
                    );
                  return (
                    <Box paddingLeft={3}>
                      <Text color={theme.dim}>
                        {glyphs.branch} {subLabel}
                        {subArgs() ? `(${subArgs()})` : ''}
                      </Text>
                    </Box>
                  );
                }}
              </For>
            </Box>
          );
        }}
      </For>
    </>
  );
}
