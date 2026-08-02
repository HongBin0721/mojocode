import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { parseVerdict, renderTranscript } from '../src/agent/goal.js';

/**
 * 评估器回复的解析,以及喂给它的抄本渲染。两者都是纯函数,与循环分开测:
 * 循环的正确性建立在"判词能读出来"和"抄本不会被 provider 拒收"之上。
 */

describe('parseVerdict', () => {
  it('读得出两行前缀格式', () => {
    expect(parseVerdict('VERDICT: MET\nREASON: 测试全绿。')).toEqual({
      met: true,
      reason: '测试全绿。',
    });
  });

  it('NOT_MET 不会被当成 MET(子串陷阱)', () => {
    const verdict = parseVerdict('VERDICT: NOT_MET\nREASON: 还有两个用例在红。');
    expect(verdict?.met).toBe(false);
    expect(verdict?.reason).toBe('还有两个用例在红。');
  });

  it('小写、连字符、空格分隔都认', () => {
    expect(parseVerdict('verdict: not met\nreason: 差一步')?.met).toBe(false);
    expect(parseVerdict('VERDICT: NOT-MET\nREASON: 差一步')?.met).toBe(false);
    expect(parseVerdict('verdict: met\nreason: 好了')?.met).toBe(true);
  });

  it('围栏与前后散文都不影响', () => {
    const text = '好的,我看了一下。\n```\nVERDICT: MET\nREASON: 构建退出码为 0。\n```\n';
    expect(parseVerdict(text)).toEqual({ met: true, reason: '构建退出码为 0。' });
  });

  it('回退认 JSON——训练里见惯 JSON 的模型仍会自作主张回一个对象', () => {
    expect(parseVerdict('{"met": false, "reason": "先把 lint 修了"}')).toEqual({
      met: false,
      reason: '先把 lint 修了',
    });
  });

  it('解释在前、JSON 在后时,不会把解释一起括进去', () => {
    const text = '我的判断如下(注意 {} 只是举例):\n{"met": true, "reason": "已通过"}';
    expect(parseVerdict(text)).toEqual({ met: true, reason: '已通过' });
  });

  it('把格式说明整行抄回来时不算达成', () => {
    // 弱模型很容易照抄提示词里的模板。子串匹配会命中其中的 MET 当场宣告
    // 达成,一声不响把活停在半截——这是本功能最坏的失败模式。
    expect(parseVerdict('VERDICT: MET or NOT_MET\nREASON: 一句话')).toBeUndefined();
    expect(parseVerdict('VERDICT: <MET or NOT_MET>\nREASON: <一句话>')).toBeUndefined();
  });

  it('markdown 装饰与句末标点不影响判定', () => {
    expect(parseVerdict('VERDICT: **MET**\nREASON: 好了')?.met).toBe(true);
    expect(parseVerdict('VERDICT: MET.\nREASON: 好了')?.met).toBe(true);
    expect(parseVerdict('**VERDICT:** `NOT_MET`\nREASON: 还差点')?.met).toBe(false);
  });

  it('判词后面跟着解释仍然认,但混进 NOT_MET 就不认', () => {
    expect(parseVerdict('VERDICT: MET — 测试全绿\nREASON: 好了')?.met).toBe(true);
    expect(parseVerdict('VERDICT: NOT_MET,还差一个\nREASON: 差一个')?.met).toBe(false);
  });

  it('判不出来返回 undefined,而不是瞎猜一个 false', () => {
    // 猜 false 会让"评估器坏了"和"确实没做完"混为一谈,循环也就永远停不下来。
    expect(parseVerdict('嗯……我不太确定。')).toBeUndefined();
    expect(parseVerdict('')).toBeUndefined();
    expect(parseVerdict('{"reason": "少了 met 字段"}')).toBeUndefined();
  });

  it('理由折行压平并截断', () => {
    const reason = 'a'.repeat(600);
    const parsed = parseVerdict(`VERDICT: NOT_MET\nREASON: ${reason}`);
    expect(parsed?.reason.length).toBe(400);
    expect(parseVerdict('VERDICT: MET\nREASON: 第一行\n第二行')?.reason).toBe('第一行 第二行');
  });
});

describe('renderTranscript', () => {
  it('渲染成一整段纯文本,而不是 ModelMessage[]', () => {
    // 原样转发历史尾部会碰上孤儿工具结果被 provider 以 400 拒收的老问题
    // (compact.ts 为此专门写了切点调整),抄本彻底绕开它。
    const text = renderTranscript([
      { role: 'user', content: '把测试跑通' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'bash', input: { cmd: 'npm test' } }],
      } as ModelMessage,
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'bash',
            output: { type: 'text', value: '2 failed' },
          },
        ],
      } as ModelMessage,
    ]);
    expect(typeof text).toBe('string');
    expect(text).toContain('[user]');
    expect(text).toContain('→ bash');
    expect(text).toContain('← bash');
    expect(text).toContain('2 failed');
  });

  it('只取尾部若干条', () => {
    const messages: ModelMessage[] = Array.from({ length: 40 }, (_, i) => ({
      role: 'user',
      content: `第${i}条`,
    }));
    const text = renderTranscript(messages);
    expect(text).toContain('第39条');
    expect(text).not.toContain('第10条');
  });

  it('逐条截断——一次 read 读进来的大文件不该把"便宜的评估"撑成最贵的一次调用', () => {
    const text = renderTranscript([{ role: 'user', content: 'x'.repeat(5000) }]);
    expect(text).toContain('[truncated]');
    expect(text.length).toBeLessThan(2000);
  });

  it('图片降级为占位符', () => {
    const text = renderTranscript([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'file', mediaType: 'image/png', data: 'AAAA' },
        ],
      } as ModelMessage,
    ]);
    expect(text).toContain('[image]');
    expect(text).not.toContain('AAAA');
  });

  it('空历史给出占位,不是空串', () => {
    expect(renderTranscript([])).toBe('(no conversation yet)');
  });
});
