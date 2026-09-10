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

function makeSession(messages: unknown[]): RemoteSession {
  return {
    snapshot: {
      config: {},
      provider: { label: 'Kimi', model: 'kimi-k3' },
      root: '/tmp/ws',
      storeId: 'abcdef1234567890',
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
});
