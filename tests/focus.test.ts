import { describe, expect, it } from 'vitest';
import { collapseItems } from '../src/ui/focus.js';
import type { TimelineItem } from '../src/ui/types.js';

let n = 0;
const key = () => `k${n++}`;
const user = (text = '问'): TimelineItem => ({ key: key(), kind: 'user', text });
const assistant = (text = '答'): TimelineItem => ({ key: key(), kind: 'assistant', text });
const reasoning = (): TimelineItem => ({ key: key(), kind: 'reasoning', durationMs: 1000 });
const tool = (toolName = 'read'): TimelineItem => ({
  key: key(),
  kind: 'tool',
  toolName,
  input: {},
  summary: 's',
  output: undefined,
  isError: false,
  durationMs: 10,
});
const notice = (level: 'info' | 'warn'): TimelineItem => ({
  key: key(),
  kind: 'notice',
  level,
  message: 'm',
});
const error = (): TimelineItem => ({ key: key(), kind: 'error', message: 'boom' });
const banner = (): TimelineItem =>
  ({ key: key(), kind: 'banner', providerLabel: 'p', model: 'm', root: '/', mode: 'ask' }) as TimelineItem;

const kinds = (items: TimelineItem[]) => items.map((i) => i.kind);

describe('collapseItems 铁律:user/assistant/error/banner 与 warn 提示恒可见', () => {
  const timeline = [
    banner(),
    user(),
    reasoning(),
    tool(),
    tool(),
    notice('warn'),
    tool(),
    assistant('中途的重要回答'),
    tool(),
    error(),
    assistant('最终回答'),
  ];

  for (const mode of ['full', 'compact', 'result'] as const) {
    it(`${mode} 档下不丢 user/assistant/error/banner/warn`, () => {
      const out = collapseItems(timeline, mode);
      expect(out.filter((i) => i.kind === 'user')).toHaveLength(1);
      // 工具调用之间的 assistant 文本一条都不能少(Claude Code #50894 的教训)
      expect(out.filter((i) => i.kind === 'assistant')).toHaveLength(2);
      expect(out.filter((i) => i.kind === 'error')).toHaveLength(1);
      expect(out.filter((i) => i.kind === 'banner')).toHaveLength(1);
      expect(out.filter((i) => i.kind === 'notice' && i.level === 'warn')).toHaveLength(1);
      // 恒可见条目的相对顺序不变(占位/过程条目忽略)
      const CORE = ['banner', 'user', 'assistant', 'error'];
      expect(out.map((i) => i.kind).filter((k) => CORE.includes(k))).toEqual(
        kinds(timeline).filter((k) => CORE.includes(k)),
      );
    });
  }
});

describe('collapseItems 各档语义', () => {
  it('full 原样返回(同一引用)', () => {
    const items = [user(), tool(), assistant()];
    expect(collapseItems(items, 'full')).toBe(items);
  });

  it('compact:连续过程段折成占位,count 只数工具', () => {
    const items = [user(), reasoning(), tool(), tool(), assistant()];
    const out = collapseItems(items, 'compact');
    expect(kinds(out)).toEqual(['user', 'collapsed', 'assistant']);
    expect((out[1] as { count: number }).count).toBe(2);
  });

  it('compact:只有思考的段静默丢弃,不留占位', () => {
    const items = [user(), reasoning(), assistant()];
    expect(kinds(collapseItems(items, 'compact'))).toEqual(['user', 'assistant']);
  });

  // /doctor 的整份报告、/mode /think /lang /focus 的确认都是 info 提示,
  // 藏掉就成了"敲了命令什么都没发生"。
  it('info 提示恒可见,并像 warn 一样切断折叠段', () => {
    const items = [user(), tool(), notice('info'), tool(), tool(), assistant()];
    const out = collapseItems(items, 'compact');
    expect(kinds(out)).toEqual(['user', 'collapsed', 'notice', 'collapsed', 'assistant']);
    expect((out[1] as { count: number }).count).toBe(1);
    expect((out[3] as { count: number }).count).toBe(2);
    // result 档同样保留
    expect(kinds(collapseItems(items, 'result'))).toEqual([
      'user',
      'notice',
      'assistant',
    ]);
  });

  it('compact:warn 提示切断折叠段(两段各自计数)', () => {
    const items = [user(), tool(), notice('warn'), tool(), tool(), assistant()];
    const out = collapseItems(items, 'compact');
    expect(kinds(out)).toEqual(['user', 'collapsed', 'notice', 'collapsed', 'assistant']);
    expect((out[1] as { count: number }).count).toBe(1);
    expect((out[3] as { count: number }).count).toBe(2);
  });

  it('compact/result:exit_plan 与 todo 是结果,保留', () => {
    const items = [user(), tool('exit_plan'), tool('todo'), tool('bash'), assistant()];
    const compact = collapseItems(items, 'compact');
    expect(compact.filter((i) => i.kind === 'tool')).toHaveLength(2);
    const result = collapseItems(items, 'result');
    expect(result.filter((i) => i.kind === 'tool')).toHaveLength(2);
    expect(kinds(result)).not.toContain('collapsed');
  });

  it('result:过程静默丢弃,无占位', () => {
    const items = [user(), reasoning(), tool(), tool(), assistant()];
    expect(kinds(collapseItems(items, 'result'))).toEqual(['user', 'assistant']);
  });

  it('占位 key 派生自段内首条,重复调用间稳定(memo 依赖)', () => {
    const items = [user(), tool(), tool(), assistant()];
    const a = collapseItems(items, 'compact');
    const b = collapseItems(items, 'compact');
    expect(a[1]?.key).toBe(b[1]?.key);
    expect(a[1]?.key).toContain('collapsed-');
  });
});
