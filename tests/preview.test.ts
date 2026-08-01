import { describe, expect, it } from 'vitest';
import { displayWidth, sliceTail, tailWithinRows } from '../src/ui/preview.js';

/** 文本在 `columns` 宽终端里实际占用的行数。 */
function wrappedRows(text: string, columns: number): number {
  return text
    .split('\n')
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(displayWidth(line) / columns)), 0);
}

describe('displayWidth', () => {
  it('CJK 字符按两列计算', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('订单号')).toBe(6);
    expect(displayWidth('a订b')).toBe(4);
  });
});

describe('sliceTail', () => {
  it('保留末尾且不超预算', () => {
    expect(sliceTail('abcdefgh', 3)).toBe('fgh');
    // 全角字符不会被从中间劈开。
    expect(sliceTail('订单号', 3)).toBe('号');
  });
});

describe('tailWithinRows', () => {
  it('保留最后若干逻辑行', () => {
    expect(tailWithinRows('a\nb\nc\nd', 2, 80)).toBe('c\nd');
  });

  it('没有换行的长段落也被压到行数预算内', () => {
    const paragraph = 'x'.repeat(3000);
    const out = tailWithinRows(paragraph, 5, 80);
    expect(wrappedRows(out, 80)).toBeLessThanOrEqual(5);
    // 保留的是结尾,而不是开头。
    expect(paragraph.endsWith(out)).toBe(true);
  });

  it('宽表格行折行后同样计入预算', () => {
    const row = '| 订单号 | 商品名称 | 客户名称 | 下单日期 | 数量 | 总金额（元） | 状态 |';
    const table = Array.from({ length: 20 }, () => row).join('\n');
    const out = tailWithinRows(table, 5, 60);
    expect(wrappedRows(out, 60)).toBeLessThanOrEqual(5);
  });

  it('窄终端下仍然收敛', () => {
    const out = tailWithinRows('中文'.repeat(500), 3, 10);
    expect(wrappedRows(out, 20)).toBeLessThanOrEqual(3);
  });
});
