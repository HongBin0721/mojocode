import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import { Box, Text, useInput, useTerminalSize, type JSX } from './kit.js';
import stringWidth from 'string-width';
import { Diff } from './Diff.js';
import { Markdown } from './Markdown.js';
import { theme, glyphs, truncateWidth, WIDTH_SAFETY } from './theme.js';
import type { PermissionDecision, PermissionRequest } from '../core/events.js';
import { t } from '../i18n/index.js';

interface Props {
  request: PermissionRequest;
  onDecide: (decision: PermissionDecision) => void;
}

/** 方案正文在确认框里最多占的**屏幕行**数,超出截断——完整方案在时间线上还在。 */
const PLAN_MAX_ROWS = 20;

/**
 * 按折行后的实际占用行数截断。
 *
 * 不能只数换行符:方案正文是成段的散文,80 列下一个自然段就能折成七八行,
 * 数出来"才 24 行"的一帧真画出来能有六十多行——确认框会把输入框和状态栏
 * 顶出视口,矮终端下用户看不到选项就没法决策。
 */
function clampRows(text: string, maxRows: number, width: number): string {
  const lines = text.split('\n');
  const cols = Math.max(1, width);
  const rowsOf = (line: string) => Math.max(1, Math.ceil(stringWidth(line) / cols));

  let rows = 0;
  for (let i = 0; i < lines.length; i += 1) {
    rows += rowsOf(lines[i]!);
    if (rows <= maxRows) continue;

    // 首行自己就超预算(一整段没有换行的长文):切掉它超出的部分,而不是
    // 只剩一行"还有 N 行"——那等于什么都没给用户看。必须按显示宽度切:
    // CJK 一个字占两列,按字符数切会得到两倍高度。
    if (i === 0) {
      const head = truncateWidth(lines[0]!, maxRows * cols);
      return lines.length > 1 ? `${head}\n${t('ui.moreLines', { n: lines.length - 1 })}` : head;
    }
    return `${lines.slice(0, i).join('\n')}\n${t('ui.moreLines', { n: lines.length - i })}`;
  }
  return text;
}

interface Option {
  label: string;
  /** 选项后面淡色展示的补充说明(建议的规则等)。 */
  note?: string;
  decision: PermissionDecision;
  danger?: boolean;
}

/**
 * 授权确认:上下键 + 回车的选项列表(主流 CLI 的交互习惯),数字键直达,
 * esc 拒绝。y/n 作为老习惯的快捷键保留。
 */
export function PermissionPrompt(props: Props): JSX.Element {
  const size = useTerminalSize();
  const [cursor, setCursor] = createSignal(0);

  // 方案审批不是"某个工具要不要放行",而是"这个方案对不对":没有可记住的
  // 规则(方案不产生规则),所以只有批准 / 继续完善两项,文案也另起一套。
  const isPlan = () => props.request.kind === 'plan';

  const options = createMemo<Option[]>(() =>
    isPlan()
      ? [
          { label: t('perm.planApprove'), decision: { type: 'allow' } },
          {
            label: t('perm.planKeepPlanning'),
            // 拒绝理由会喂给模型,保持英文。
            decision: { type: 'deny', reason: 'the user wants to keep refining the plan' },
          },
        ]
      : [
          { label: t('perm.allowOnce'), decision: { type: 'allow' } },
          ...(props.request.suggestedRule
            ? ([
                {
                  label: t('perm.alwaysSession'),
                  note: props.request.suggestedRule,
                  decision: { type: 'allow-always', rule: props.request.suggestedRule },
                },
                {
                  label: t('perm.alwaysPersist'),
                  note: props.request.suggestedRule,
                  decision: { type: 'allow-persist', rule: props.request.suggestedRule },
                },
              ] satisfies Option[])
            : []),
          { label: t('perm.deny'), decision: { type: 'deny' }, danger: true },
        ],
  );

  // 换成另一个请求时组件并不卸载(只有 permission 变 undefined 才卸载),
  // cursor 会跨请求残留下来。
  createEffect(on(() => props.request.id, () => setCursor(0), { defer: true }));

  // 一律走钳制后的下标:上一个请求有 4 个选项、光标停在第 4 项,下一个
  // 请求只有 2 个选项时,回车会读到 undefined 并让整个 TUI 崩掉。
  const selected = () => Math.min(cursor(), options().length - 1);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => (c + options().length - 1) % options().length);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % options().length);
      return;
    }
    if (key.return) {
      props.onDecide(options()[selected()]!.decision);
      return;
    }
    if (key.escape) {
      // 方案审批下 esc 是"继续完善",不是硬拒;理由要跟着一起给模型。
      props.onDecide(isPlan() ? options()[options().length - 1]!.decision : { type: 'deny' });
      return;
    }
    // 数字键直达对应选项。必须限定单字符:粘贴会作为一整个 input 到达,
    // parseInt 只取首位数字,"3 files changed…" 会被当成按下 3 而误选。
    if (/^[1-9]$/.test(input)) {
      const digit = Number(input);
      if (digit <= options().length) {
        props.onDecide(options()[digit - 1]!.decision);
        return;
      }
    }
    // 老习惯的快捷键。方案审批不接:y/n 对"批准方案"太含糊,一个手滑就
    // 让整份方案过了,这里只认明确的选项。
    if (isPlan()) return;
    if (input.toLowerCase() === 'y') props.onDecide({ type: 'allow' });
    else if (input.toLowerCase() === 'n') props.onDecide({ type: 'deny' });
  });

  const isDiff = () => props.request.detail?.includes('@@') ?? false;

  return (
    // 不设 marginTop:与上方(状态行或时间线)的分隔由 App 底部固定区的
    // 外层容器统一给出一行,这里再叠一层缝就宽一倍。
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={isPlan() ? theme.accent : theme.warn}
      paddingX={1}
    >
      <Text bold color={isPlan() ? theme.accent : theme.warn}>
        {isPlan() ? t('perm.planTitle') : t('perm.title')}
      </Text>
      <Show when={!isPlan()}>
        <Text>{props.request.title}</Text>
      </Show>

      <Show when={props.request.detail}>
        <Box marginTop={1} flexDirection="column">
          {isPlan() ? (
            // 方案正文是 markdown。必须限高:不能让确认框比视口还高。
            // 截断不丢东西——完整方案随后会作为 exit_plan 的工具条目进时间线。
            <Markdown
              text={clampRows(
                props.request.detail!,
                PLAN_MAX_ROWS,
                // 圆角边框 + paddingX 各占 2 列。
                size.columns - 4 - WIDTH_SAFETY,
              )}
            />
          ) : isDiff() ? (
            <Diff patch={props.request.detail!} maxLines={20} />
          ) : (
            <Text color={theme.dim}>{clamp(props.request.detail!, 20)}</Text>
          )}
        </Box>
      </Show>

      <Box marginTop={1} flexDirection="column">
        <For each={options()}>
          {(option, index) => {
            const active = () => index() === selected();
            const color = () => (option.danger ? theme.error : active() ? theme.accent : undefined);
            return (
              // 点击直接决策,与数字键直达同一档语义(都不经过光标)。
              <Text
                color={active() ? color() ?? theme.accent : undefined}
                onClick={() => props.onDecide(option.decision)}
              >
                {active() ? `${glyphs.pointer} ` : '  '}
                <Text color={theme.dim}>{index() + 1}.</Text>{' '}
                <Text color={color()} bold={active()}>
                  {option.label}
                </Text>
                {option.note ? <Text color={theme.dim}> ({option.note})</Text> : null}
              </Text>
            );
          }}
        </For>
        <Box marginTop={1}>
          <Text color={theme.dim}>{isPlan() ? t('perm.planHint') : t('perm.hint')}</Text>
        </Box>
      </Box>
    </Box>
  );
}

function clamp(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join('\n')}\n${t('ui.moreLines', { n: lines.length - maxLines })}`;
}
