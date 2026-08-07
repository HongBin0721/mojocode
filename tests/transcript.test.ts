import { describe, expect, it } from 'vitest';
import { formatTranscript } from '../src/ui/transcript.js';
import type { TimelineItem } from '../src/ui/types.js';

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

const tool = (over: Partial<Extract<TimelineItem, { kind: 'tool' }>>): TimelineItem => ({
  key: over.key ?? 'k',
  kind: 'tool',
  toolName: 'read',
  input: {},
  summary: 's',
  output: undefined,
  isError: false,
  durationMs: 10,
  ...over,
});

describe('formatTranscript 保真度(退出 dump 是唯一留档)', () => {
  it('exit_plan 的方案正文完整落盘', () => {
    const out = plain(
      formatTranscript(
        [tool({ toolName: 'exit_plan', input: { plan: '# 方案\n\n第一步做 A,第二步做 B。' }, summary: '已批准' })],
        80,
      ),
    );
    expect(out).toContain('第一步做 A');
    expect(out).toContain('已批准');
  });

  it('write 的 diff 逐行落盘', () => {
    const patch = '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-旧行\n+新行\n';
    const out = plain(formatTranscript([tool({ toolName: 'write', output: { diff: patch } })], 80));
    expect(out).toContain('+新行');
    expect(out).toContain('-旧行');
  });

  it('todo 清单逐项落盘', () => {
    const out = plain(
      formatTranscript(
        [
          tool({
            toolName: 'todo',
            input: { todos: [{ content: '写测试', status: 'completed' }, { content: '收尾', status: 'pending' }] },
          }),
        ],
        80,
      ),
    );
    expect(out).toContain('☒ 写测试');
    expect(out).toContain('☐ 收尾');
  });

  it('bash 输出与时间线同限(12 行 + 折叠标记)', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n');
    const out = plain(
      formatTranscript([tool({ toolName: 'bash', input: { command: 'ls' }, output: { output: lines } })], 80),
    );
    expect(out).toContain('line-0');
    expect(out).toContain('line-11');
    expect(out).not.toContain('line-12');
  });

  it('普通条目形态:用户/回答/提示/报错/分隔线', () => {
    const items: TimelineItem[] = [
      { key: 'u', kind: 'user', text: '问题' },
      { key: 'a', kind: 'assistant', text: '**答案**' },
      { key: 'n', kind: 'notice', level: 'warn', message: '警告' },
      { key: 'e', kind: 'error', message: '崩了' },
      { key: 'd', kind: 'divider', label: '已恢复' },
    ];
    const out = plain(formatTranscript(items, 80));
    expect(out).toContain('> 问题');
    expect(out).toContain('答案');
    expect(out).toContain('! 警告');
    expect(out).toContain('✗ 崩了');
    expect(out).toContain('── 已恢复 ──');
  });
});
