import { describe, expect, it } from 'vitest';
import { Box } from '../../src/ui/kit.js';
import { TimelineEntry } from '../../src/ui/Timeline.js';
import type { TimelineItem } from '../../src/ui/types.js';
import { renderPixelLogo } from '../../src/ui/logo.js';
import { APP_NAME } from '../../src/config/paths.js';
import { renderUi } from '../support/otui.js';

function entries(items: TimelineItem[], columns = 80, expanded = false) {
  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <TimelineEntry item={item} columns={columns} expanded={expanded} />
      ))}
    </Box>
  );
}

describe('TimelineEntry 在 OpenTUI 下渲染', () => {
  it('user/assistant/reasoning/notice/error/divider 全 kind 冒烟', async () => {
    const ui = await renderUi(
      () => entries([
        { key: 'i1', kind: 'user', text: '帮我看看这个文件' },
        { key: 'i2', kind: 'assistant', text: '这是**回答**,含 `代码`。' },
        { key: 'i3', kind: 'reasoning', durationMs: 3200, text: '先看看文件' },
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

  const bashItem: TimelineItem = {
    key: 't2',
    kind: 'tool',
    toolName: 'bash',
    input: { command: 'ls -la' },
    summary: 'exit 0 · 0.1s',
    output: { output: 'file-a.txt\nfile-b.txt' },
    isError: false,
    durationMs: 100,
  };

  it('tool 条目:名称/参数/摘要,bash 输出默认折叠', async () => {
    const ui = await renderUi(
      () => entries([
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
        bashItem,
      ]),
      { width: 70, height: 16 },
    );
    const frame = ui.frame();
    expect(frame).toContain('Read(src/index.ts)');
    expect(frame).toContain('⎿');
    expect(frame).toContain('读取 120 行');
    // 输出正文默认不摊开,只留一行可展开的占位。
    expect(frame).not.toContain('file-a.txt');
    expect(frame).toContain('+ 2');
    await ui.destroy();
  });

  it('expanded 时 bash 输出摊开', async () => {
    const ui = await renderUi(() => entries([bashItem], 70, true), { width: 70, height: 16 });
    const frame = ui.frame();
    expect(frame).toContain('file-a.txt');
    expect(frame).toContain('file-b.txt');
    await ui.destroy();
  });

  it('思考:默认一行带 + 标记,expanded 时摊开正文', async () => {
    const item: TimelineItem = {
      key: 'r1',
      kind: 'reasoning',
      durationMs: 3200,
      text: '先读文件再决定改哪里',
    };
    const collapsed = await renderUi(() => entries([item]), { width: 60, height: 8 });
    expect(collapsed.frame()).toContain('+');
    expect(collapsed.frame()).not.toContain('先读文件再决定改哪里');
    await collapsed.destroy();

    const shown = await renderUi(() => entries([item], 60, true), { width: 60, height: 8 });
    expect(shown.frame()).toContain('先读文件再决定改哪里');
    await shown.destroy();
  });

  it('一轮的收尾行:模型 · 耗时 · token', async () => {
    const ui = await renderUi(
      () => entries([{ key: 'e1', kind: 'turn', model: 'kimi-k3', durationMs: 12500, tokens: 3400 }]),
      { width: 60, height: 4 },
    );
    const frame = ui.frame();
    expect(frame).toContain('▣');
    expect(frame).toContain('kimi-k3');
    expect(frame).toContain('12.5s');
    expect(frame).toContain('3.4k');
    await ui.destroy();
  });

  it('用户消息折行挂在提示符右侧,第二行不顶到第 0 列', async () => {
    const ui = await renderUi(
      () => entries([{ key: 'u1', kind: 'user', text: 'a'.repeat(40) }], 24),
      { width: 24, height: 8 },
    );
    const lines = ui.frame().split('\n').filter((l) => l.trim());
    const wrapped = lines.filter((l) => l.includes('aaa'));
    expect(wrapped.length).toBeGreaterThan(1);
    // 每一行都从提示符所在的缩进开始,没有一行贴着第 0 列写正文
    for (const line of wrapped.slice(1)) expect(line.startsWith('a')).toBe(false);
    await ui.destroy();
  });

  it('write 工具带 diff 输出时渲染 Diff', async () => {
    const patch = '--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-old line\n+new line\n';
    const ui = await renderUi(
      () => entries([
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
      () => entries([
        {
          key: 'b1',
          kind: 'banner',
          providerLabel: 'Kimi',
          model: 'kimi-k3',
          root: '/tmp/x',
          mode: 'ask',
        },
      ]),
      { width: 60, height: 16 },
    );
    expect(ui.frame()).toContain(renderPixelLogo(APP_NAME)[0]!.join(''));
    expect(ui.frame()).toContain('kimi-k3');
    await ui.destroy();
  });
});
