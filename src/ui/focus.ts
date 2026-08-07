import type { TimelineMode } from '../config/schema.js';
import type { TimelineItem } from './types.js';

export type { TimelineMode };

/**
 * /focus 的时间线过滤(全屏渲染下切换 = 换谓词重画,随时双向可逆)。
 *
 * **铁律:`user` / `assistant` / `error` / `banner` 与全部 `notice`
 * 在任何档位都不隐藏。** Claude Code 的 /focus 靠语义猜"状态更新还是答案",
 * 把工具调用之间的 assistant 正文连着警告一起藏掉,用户错过答案且无从知晓
 * (issue #50894,High severity)。我们有 kind 标签,不必猜——这条约束由
 * tests/focus.test.ts 锁死,改这里前先看那边。
 *
 * notice 整类都不隐藏,包括 info:斜杠命令的回执正是 info 提示——`/doctor`
 * 的整份报告、`/mode` `/think` `/lang` 的确认、乃至 `/focus` 自己的确认
 * 都是,藏掉就成了"敲了命令什么都没发生"。真正的噪音是工具调用与思考,
 * 提示本身量很小。
 *
 * 三档:
 * - `full`    全量,原样返回;
 * - `compact` 折叠过程:连续的工具调用/思考合并为一条「⋯ N 个工具调用
 *             已折叠」占位(exit_plan 方案正文与 todo 清单是结果不是噪音,
 *             保留);
 * - `result`  只看问答:过程静默丢弃,不留占位。
 */
export function collapseItems(items: TimelineItem[], mode: TimelineMode): TimelineItem[] {
  if (mode === 'full') return items;

  const out: TimelineItem[] = [];
  let run: TimelineItem[] = [];

  const flushRun = (): void => {
    if (run.length === 0) return;
    if (mode === 'compact') {
      const count = run.filter((r) => r.kind === 'tool').length;
      // 只含思考的段不值得占一行,静默丢弃。
      if (count > 0) {
        const first = run[0]!;
        // key 派生自首个被隐藏条目:同一段在多次重渲染间 key 稳定,memo 有效。
        out.push({ key: `collapsed-${first.key}`, kind: 'collapsed', count });
      }
    }
    run = [];
  };

  for (const item of items) {
    if (hidden(item)) {
      run.push(item);
      continue;
    }
    flushRun();
    out.push(item);
  }
  flushRun();
  return out;
}

/** 该条目在 compact/result 下是否隐藏。 */
function hidden(item: TimelineItem): boolean {
  switch (item.kind) {
    case 'reasoning':
      return true;
    case 'tool':
      // 方案正文与任务清单是结果,不是过程噪音。
      return item.toolName !== 'exit_plan' && item.toolName !== 'todo';
    default:
      // user / assistant / error / banner / notice / divider / collapsed:
      // 铁律,恒可见(notice 含 info,理由见文件头注释)。
      return false;
  }
}
