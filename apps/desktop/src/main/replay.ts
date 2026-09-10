/**
 * 回放条目(main 侧执行):src/session/replay.ts 的链路依赖 node:fs/execa/
 * ai(经 summarizeToolResult),renderer 构建打不进去,所以在 main 进程把
 * displayMessages 还原成 TimelineItem[],经 bridge:replay 下发。
 *
 * 对应 TUI 侧 sessionBanner + buildResumeItems(timeline-controller.ts 的
 * 两个组装函数)。条目 key 用 `replay-` 前缀——renderer 的 reducer 计数器
 * 生成 `item-N`,两套进程各有计数器,前缀隔开才能共处一个列表。
 */

import { t } from '@core/i18n';
import { replayTimeline } from '@core/replay';
import { SessionStore } from '@core/session-store';
import type { TimelineItem } from '@core/types';
import type { RemoteSession } from '@core/remote';

/**
 * 展示历史 → 带 `replay-` 前缀 key 的时间线条目(磁盘预览与正式回放共用)。
 * total 给预览的截尾用:分隔行照报完整消息数,条目只还原传入的尾部。
 */
/**
 * 回放里随条目带出的图片字节预算(base64 字符数)。常量住在这里而不是核心:
 * 它衡量的是**这条 IPC 结构化克隆**能有多大——每次切焦点推一次整份回放,
 * 与「历史怎么还原成条目」无关。约 3MB 原图,够看清最近几条。
 */
const REPLAY_IMAGE_BUDGET = 4_000_000;

/**
 * 预览的预算单列且小得多:它必然被正式回放整桶替换掉,而它存在的理由就是
 * 让点击**立刻**有反应——在这条路上拷几兆 base64 恰好是最慢的一环。
 */
const PREVIEW_IMAGE_BUDGET = 400_000;

function replayedItems(
  messages: Parameters<typeof replayTimeline>[0],
  sessionId: string,
  total = messages.length,
  imageBudget = REPLAY_IMAGE_BUDGET,
): TimelineItem[] {
  return [
    {
      key: 'replay-divider',
      kind: 'divider',
      label: t('divider.resumed', { id: sessionId.slice(0, 8), n: total }),
    },
    // GUI 画得了图:显式给预算(核心不给预算就一张不带——终端只渲染标签)。
    // 预算内的最近几条带图,更早的退回纯标签,这份结构化克隆因此有上界。
    ...replayTimeline(messages, { imageBudget }).map(
      (item, index) => ({ ...item, key: `replay-${index}` }) as TimelineItem,
    ),
  ];
}

/**
 * 预览只需要填满视口:长会话整段 replayTimeline + IPC 结构化克隆是 O(会话
 * 大小) 的主进程开销,而正式回放马上就来整桶替换,截尾把这份被丢弃的工作
 * 压成常数。
 */
const PREVIEW_MAX_MESSAGES = 40;

/**
 * 磁盘直读的预览回放:openTask 复活休眠会话要经历整个 sidecar 冷启动
 * (spawn + bootstrap + --resume),用户点开后不该盯几秒白屏——先把 JSONL
 * 里的展示历史还原成时间线推过去,sidecar 连上后 createTask 的正式回放会
 * 整桶替换(banner 依赖 resolved provider 快照,预览里没有,由正式回放补)。
 */
export async function buildDiskReplayItems(sessionId: string): Promise<TimelineItem[]> {
  const store = await SessionStore.open(sessionId);
  const messages = store.displayMessages;
  const items: TimelineItem[] =
    messages.length > 0
      ? replayedItems(
          messages.slice(-PREVIEW_MAX_MESSAGES),
          sessionId,
          messages.length,
          PREVIEW_IMAGE_BUDGET,
        )
      : [];
  items.push({
    key: 'replay-reviving',
    kind: 'notice',
    level: 'info',
    message: t('notice.taskReviving'),
  });
  return items;
}

export function buildReplayItems(session: RemoteSession): TimelineItem[] {
  const snap = session.snapshot;
  const banner: TimelineItem = {
    key: 'replay-banner',
    kind: 'banner',
    providerLabel: snap.provider.label,
    model: snap.provider.model,
    root: snap.root,
  };

  // 回放读**展示历史**(压缩不缩减):用户恢复会话该看到原始对话。
  const messages = session.store.displayMessages;
  if (messages.length === 0) return [banner];

  // 扩展的恢复提示(如 /goal 的「目标待续」)不在这里补:它们的状态行随快照
  // 常驻在输入框上方,启动时没人听见的 notice 不必伪造一条。
  return [banner, ...replayedItems(messages, snap.storeId)];
}
