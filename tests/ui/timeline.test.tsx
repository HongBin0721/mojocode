import { describe, expect, it } from 'vitest';
import React from 'react';
import { Box } from '../../src/ui/kit.js';
import { TimelineEntry } from '../../src/ui/Timeline.js';
import type { TimelineItem } from '../../src/ui/types.js';
import { renderUi } from '../support/otui.js';

function entries(items: TimelineItem[], columns = 80) {
  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <TimelineEntry key={item.key} item={item} columns={columns} />
      ))}
    </Box>
  );
}

describe('TimelineEntry 在 OpenTUI 下渲染', () => {
  it('user/assistant/reasoning/notice/error/divider 全 kind 冒烟', async () => {
    const ui = await renderUi(
      entries([
        { key: 'i1', kind: 'user', text: '帮我看看这个文件' },
        { key: 'i2', kind: 'assistant', text: '这是**回答**,含 `代码`。' },
        { key: 'i3', kind: 'reasoning', durationMs: 3200 },
        { key: 'i4', kind: 'notice', level: 'warn', message: '有告警' },
        { key: 'i5', kind: 'error', message: '出错了' },
        { key: 'i6', kind: 'divider', label: '已恢复' },
      ]),
      { width: 60, height: 20 },
    );
    const frame = ui.frame();
    expect(frame).toContain('> 帮我看看这个文件');
    expect(frame).toContain('⏺ ');
    expect(frame).toContain('回答');
    expect(frame).toContain('✻');
    expect(frame).toContain('! 有告警');
    expect(frame).toContain('✗ 出错了');
    expect(frame).toContain('── 已恢复 ──');
    // markdown 渲染的 ANSI 不应以字面转义出现
    expect(frame).not.toContain('[3');
    await ui.destroy();
  });

  it('tool 条目:名称/参数/摘要与 bash 输出', async () => {
    const ui = await renderUi(
      entries([
        {
          key: 't1',
          kind: 'tool',
          toolName: 'read',
          input: { path: 'src/index.ts' },
          summary: '读取 120 行',
          output: undefined,
          isError: false,
          durationMs: 100,
        },
        {
          key: 't2',
          kind: 'tool',
          toolName: 'bash',
          input: { command: 'ls -la' },
          summary: 'exit 0 · 0.1s',
          output: { output: 'file-a.txt\nfile-b.txt' },
          isError: false,
          durationMs: 100,
        },
      ]),
      { width: 70, height: 16 },
    );
    const frame = ui.frame();
    expect(frame).toContain('Read(src/index.ts)');
    expect(frame).toContain('⎿');
    expect(frame).toContain('读取 120 行');
    expect(frame).toContain('file-a.txt');
    expect(frame).toContain('file-b.txt');
    await ui.destroy();
  });

  it('write 工具带 diff 输出时渲染 Diff', async () => {
    const patch = '--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-old line\n+new line\n';
    const ui = await renderUi(
      entries([
        {
          key: 'd1',
          kind: 'tool',
          toolName: 'write',
          input: { path: 'x.ts' },
          summary: '已写入',
          output: { diff: patch },
          isError: false,
          durationMs: 50,
        },
      ]),
      { width: 60, height: 12 },
    );
    const frame = ui.frame();
    expect(frame).toContain('+ new line');
    expect(frame).toContain('- old line');
    await ui.destroy();
  });

  it('banner 渲染 Header', async () => {
    const ui = await renderUi(
      entries([
        {
          key: 'b1',
          kind: 'banner',
          providerLabel: 'Kimi',
          model: 'kimi-k3',
          root: '/tmp/x',
          mode: 'ask',
        },
      ]),
      { width: 60, height: 10 },
    );
    expect(ui.frame()).toContain('mojocode');
    expect(ui.frame()).toContain('kimi-k3');
    await ui.destroy();
  });
});
