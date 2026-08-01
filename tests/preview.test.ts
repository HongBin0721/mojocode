import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { splitCommitted, tailWithinRows } from '../src/ui/preview.js';

/** 文本在 `columns` 宽终端里实际占用的行数(输出已按该宽度预折行)。 */
function rows(text: string, columns: number): number {
  return text.split('\n').reduce((sum, line) => {
    expect(stringWidth(line)).toBeLessThanOrEqual(columns);
    return sum + 1;
  }, 0);
}

/**
 * 镜像 Markdown.tsx 的渲染变换,计算文本实际渲染后的终端行数:
 * 围栏行不渲染、代码行加 2 列缩进、分隔线展开为 30 个 ─。
 */
function renderedHeight(text: string, columns: number): number {
  let fence = false;
  let total = 0;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    let rendered = line;
    if (fence) rendered = `  ${line}`;
    else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) rendered = '─'.repeat(30);
    total += Math.max(1, Math.ceil(stringWidth(rendered) / columns));
  }
  return total;
}

describe('tailWithinRows', () => {
  it('保留最后若干逻辑行', () => {
    expect(tailWithinRows('a\nb\nc\nd', 2, 80)).toBe('c\nd');
  });

  it('没有换行的长段落也被压到行数预算内', () => {
    const paragraph = 'x'.repeat(3000);
    const out = tailWithinRows(paragraph, 5, 80);
    expect(rows(out, 80)).toBeLessThanOrEqual(5);
    // 保留的是结尾,而不是开头。
    expect(paragraph.endsWith(out.replace(/\n/g, ''))).toBe(true);
  });

  it('宽表格行折行后同样计入预算', () => {
    const row = '| 订单号 | 商品名称 | 客户名称 | 下单日期 | 数量 | 总金额（元） | 状态 |';
    const table = Array.from({ length: 20 }, () => row).join('\n');
    const out = tailWithinRows(table, 5, 60);
    let used = 0;
    for (const line of out.split('\n')) {
      used += Math.max(1, Math.ceil(stringWidth(line) / 60));
    }
    expect(used).toBeLessThanOrEqual(5);
  });

  it('CJK 全角宽度按两列计算', () => {
    // 20 个汉字 = 40 列,在 20 列宽终端折成 2 行,预算 1 行时必须截断。
    const out = tailWithinRows('中'.repeat(20), 1, 20);
    expect(stringWidth(out)).toBeLessThanOrEqual(20);
  });

  it('窄终端下仍然收敛', () => {
    const out = tailWithinRows('中文'.repeat(500), 3, 10);
    // columns 下限收敛到 20。
    expect(rows(out, 20)).toBeLessThanOrEqual(3);
  });

  it('代码块行按 +2 缩进估算,渲染高度不超预算', () => {
    // 79 字符的代码行加 2 列缩进 = 81 列,在 80 列终端折成 2 行。
    const code = 'x'.repeat(79);
    const text = '```\n' + `${code}\n`.repeat(4) + '```';
    const out = tailWithinRows(text, 5, 80);
    expect(renderedHeight(out, 80)).toBeLessThanOrEqual(5);
  });

  it('分隔线在窄终端按 30 列估算', () => {
    const out = tailWithinRows('a\n---\nb', 2, 20);
    expect(renderedHeight(out, 20)).toBeLessThanOrEqual(2);
  });

  it('截断落在代码块中间时补开栏,栏内外状态不反转', () => {
    // 未闭合的流式代码块,长到必然截断。
    const text = '```\n' + Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const out = tailWithinRows(text, 3, 80);
    expect(out.startsWith('```\n')).toBe(true);
    expect(renderedHeight(out, 80)).toBeLessThanOrEqual(3);
  });
});

describe('splitCommitted', () => {
  it('没有空行时不提交', () => {
    expect(splitCommitted('还在生成的段落')).toEqual({ committed: '', rest: '还在生成的段落' });
  });

  it('空行收尾的段落被提交,尾段保留', () => {
    expect(splitCommitted('第一段\n\n第二段还在生成')).toEqual({
      committed: '第一段',
      rest: '第二段还在生成',
    });
  });

  it('多个完成段落一起提交,切在最后一个空行', () => {
    expect(splitCommitted('一\n\n二\n\n三未完')).toEqual({ committed: '一\n\n二', rest: '三未完' });
  });

  it('代码围栏内的空行不是切点', () => {
    const text = '```\na\n\nb';
    expect(splitCommitted(text)).toEqual({ committed: '', rest: text });
  });

  it('围栏前的段落照常提交,围栏整体留在尾段', () => {
    expect(splitCommitted('说明:\n\n```\ncode\n\nmore')).toEqual({
      committed: '说明:',
      rest: '```\ncode\n\nmore',
    });
  });

  it('闭合后的围栏可以随下一个空行提交', () => {
    expect(splitCommitted('```\ncode\n```\n\n后续段落')).toEqual({
      committed: '```\ncode\n```',
      rest: '后续段落',
    });
  });

  it('文本恰好结束在空行,全部提交', () => {
    expect(splitCommitted('完整段落\n\n')).toEqual({ committed: '完整段落', rest: '' });
  });

  it('不切开松散有序列表(否则每项都从 1 重新编号)', () => {
    expect(splitCommitted('计划:\n\n1. 一\n\n2. 二\n\n3. 三未完')).toEqual({
      committed: '计划:',
      rest: '1. 一\n\n2. 二\n\n3. 三未完',
    });
  });

  it('不切开松散无序列表及其缩进续行', () => {
    expect(splitCommitted('- 一\n\n   续行\n\n- 二未完')).toEqual({
      committed: '',
      rest: '- 一\n\n   续行\n\n- 二未完',
    });
  });

  it('逐字符流式喂入时也不切开有序列表', () => {
    // 关键回归:判断切点时若采信尚未接收完整的末行(只到 `2`,`. ` 未到),
    // 会误判它不是列表项而提前提交,列表被拆成独立文档、序号各自从 1 开始。
    const text = '计划:\n\n1. 一\n\n2. 二\n\n3. 三未完';
    const chunks: string[] = [];
    let acc = '';
    for (const ch of text) {
      acc += ch;
      const { committed, rest } = splitCommitted(acc);
      if (committed) {
        chunks.push(committed);
        acc = rest;
      }
    }
    expect(chunks).toEqual(['计划:']);
    expect(acc).toBe('1. 一\n\n2. 二\n\n3. 三未完');
  });

  it('列表结束后的普通段落照常提交', () => {
    expect(splitCommitted('1. 一\n2. 二\n\n结论段落\n\n尾段')).toEqual({
      committed: '1. 一\n2. 二\n\n结论段落',
      rest: '尾段',
    });
  });
});
