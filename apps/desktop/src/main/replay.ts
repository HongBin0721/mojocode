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
import { permissionsLabel } from '@core/schema';
import type { TimelineItem } from '@core/types';
import type { RemoteSession } from '@core/remote';

export function buildReplayItems(session: RemoteSession): TimelineItem[] {
  const snap = session.snapshot;
  const mode = snap.config.plan
    ? 'plan'
    : permissionsLabel({ sandbox: snap.config.sandbox, approval: snap.config.approval });
  const connected = snap.mcpStatuses.filter((status) => status.connected).length;
  const banner: TimelineItem = {
    key: 'replay-banner',
    kind: 'banner',
    providerLabel: snap.provider.label,
    model: snap.provider.model,
    root: snap.root,
    mode,
    mcpSummary:
      snap.mcpStatuses.length > 0 ? `${connected}/${snap.mcpStatuses.length}` : undefined,
  };

  // 回放读**展示历史**(压缩不缩减):用户恢复会话该看到原始对话。
  const messages = session.store.displayMessages;
  if (messages.length === 0) return [banner];

  const replayed = replayTimeline(messages);
  const items: TimelineItem[] = [
    banner,
    {
      key: 'replay-divider',
      kind: 'divider',
      label: t('divider.resumed', { id: snap.storeId.slice(0, 8), n: messages.length }),
    },
    ...replayed.map((item, index) => ({ ...item, key: `replay-${index}` }) as TimelineItem),
  ];
  // 恢复的目标在 bootstrap 期就 restore 过,那条 goal-start 没人听见——补一次
  // 提示(与 TUI 挂载时的补条一致)。
  if (snap.goal.restored) {
    items.push({
      key: 'replay-goal-restored',
      kind: 'notice',
      level: 'info',
      message: t('notice.goalRestored', { condition: snap.goal.status?.condition ?? '' }),
    });
  }
  return items;
}
