/**
 * main/replay.ts 的纯函数测试:snapshot + displayMessages → TimelineItem[]。
 * 只伪造 buildReplayItems 实际读到的字段(RemoteSession 形状经 as 收窄,
 * 与 bridge.test.ts 的 harness 同一路数)。
 */

import { describe, expect, it } from 'vitest';
import type { RemoteSession } from '@core/remote';
import { setLocale } from '@core/i18n';
import { buildReplayItems } from '../src/main/replay.js';

setLocale('zh-CN'); // 钉死语言,断言不随环境 LANG 漂移

interface SnapshotSeed {
  plan?: boolean;
  mcpStatuses?: Array<{ connected: boolean }>;
  goal?: { restored?: boolean; status?: { condition: string } };
}

function makeSession(messages: unknown[], seed: SnapshotSeed = {}): RemoteSession {
  return {
    snapshot: {
      config: { plan: seed.plan ?? false, sandbox: 'workspace-write', approval: 'ask' },
      mcpStatuses: seed.mcpStatuses ?? [],
      provider: { label: 'Kimi', model: 'kimi-k3' },
      root: '/tmp/ws',
      storeId: 'abcdef1234567890',
      goal: seed.goal ?? { restored: false },
    },
    store: { displayMessages: messages },
  } as unknown as RemoteSession;
}

describe('buildReplayItems', () => {
  it('空历史 → 只有 banner,携带 provider/model/root', () => {
    const items = buildReplayItems(makeSession([]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: 'replay-banner',
      kind: 'banner',
      providerLabel: 'Kimi',
      model: 'kimi-k3',
      root: '/tmp/ws',
    });
  });

  it('mode:plan 优先于 permissionsLabel;非 plan 时用权限档位标签', () => {
    const planBanner = buildReplayItems(makeSession([], { plan: true }))[0] as { mode: string };
    expect(planBanner.mode).toBe('plan');
    const normalBanner = buildReplayItems(makeSession([]))[0] as { mode: string };
    expect(normalBanner.mode).not.toBe('plan');
    expect(normalBanner.mode.length).toBeGreaterThan(0);
  });

  it('mcpSummary:空列表 undefined,非空为 connected/total', () => {
    const none = buildReplayItems(makeSession([]))[0] as { mcpSummary?: string };
    expect(none.mcpSummary).toBeUndefined();
    const some = buildReplayItems(
      makeSession([], { mcpStatuses: [{ connected: true }, { connected: false }] }),
    )[0] as { mcpSummary?: string };
    expect(some.mcpSummary).toBe('1/2');
  });

  it('非空历史 → banner + divider(storeId 前 8 位与条数)+ replay-N 条目', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const items = buildReplayItems(makeSession(messages));
    expect(items[0]!.key).toBe('replay-banner');
    expect(items[1]).toMatchObject({ key: 'replay-divider', kind: 'divider' });
    expect((items[1] as { label: string }).label).toContain('abcdef12');
    expect((items[1] as { label: string }).label).toContain('2');
    for (const item of items.slice(2)) expect(item.key).toMatch(/^replay-\d+$/);
    expect(items.length).toBeGreaterThan(2);
  });

  it('goal.restored → 末尾补 notice(空历史不补,快路径直接返回)', () => {
    const goal = { restored: true, status: { condition: '测试全绿' } };
    const messages = [{ role: 'user', content: 'hi' }];
    const items = buildReplayItems(makeSession(messages, { goal }));
    const last = items[items.length - 1]!;
    expect(last).toMatchObject({ key: 'replay-goal-restored', kind: 'notice', level: 'info' });
    expect((last as { message: string }).message).toContain('测试全绿');
    // 空历史走 [banner] 快路径,不补 notice——行为如此,锁下来。
    const empty = buildReplayItems(makeSession([], { goal }));
    expect(empty).toHaveLength(1);
  });
});
