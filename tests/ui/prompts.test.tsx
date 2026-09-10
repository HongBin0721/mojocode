import { describe, expect, it } from 'vitest';
import { RewindPicker } from '../../src/ui/RewindPicker.js';
import { SessionPicker } from '../../src/ui/SessionPicker.js';
import { renderUi } from '../support/otui.js';

describe('RewindPicker', () => {
  const entries = [
    { index: 4, ordinal: 3, text: '第三条消息' },
    { index: 2, ordinal: 2, text: '第二条消息' },
    { index: 0, ordinal: 1, text: '第一条消息' },
  ];

  it('列表渲染与选择', async () => {
    const picked: number[] = [];
    const ui = await renderUi(
      () => <RewindPicker entries={entries} onPick={(e) => picked.push(e.ordinal)} onCancel={() => {}} />,
      { width: 60, height: 10 },
    );
    expect(ui.frame()).toContain('第三条消息');
    await ui.press('down');
    await ui.press('return');
    expect(picked).toEqual([2]);
    await ui.destroy();
  });

  it('esc 取消', async () => {
    let cancelled = false;
    const ui = await renderUi(
      () => <RewindPicker entries={entries} onPick={() => {}} onCancel={() => (cancelled = true)} />,
      { width: 60, height: 10 },
    );
    await ui.press('escape');
    expect(cancelled).toBe(true);
    await ui.destroy();
  });
});

describe('SessionPicker', () => {
  it('渲染会话列表并选择', async () => {
    const chosen: (string | undefined)[] = [];
    const ui = await renderUi(
      () => <SessionPicker
        sessions={[
          {
            id: 'abc123',
            updatedAt: '2026-08-07T12:00:00.000Z',
            provider: 'deepseek',
            model: 'deepseek-chat',
            messageCount: 4,
            title: '修复登录问题',
          } as never,
        ]}
        onSelect={(id) => chosen.push(id)}
      />,
      { width: 80, height: 10 },
    );
    expect(ui.frame()).toContain('修复登录问题');
    await ui.press('return');
    expect(chosen).toEqual(['abc123']);
    await ui.destroy();
  });
});
