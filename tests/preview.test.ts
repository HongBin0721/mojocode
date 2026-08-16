import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { splitCommitted, tailWithinRows } from '../src/ui/preview.js';

/** 一行在 columns 宽终端里硬折行后的物理行数(与 preview.ts 同一套测量)。 */
function renderedRows(line: string, columns: number): number {
  return wrapAnsi(line, columns, { hard: true, trim: false }).split('\n').length;
}

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

  // 逐 delta 全量重排是 O(n²),CI 的 ubuntu+Bun 比本地慢 5 倍以上,默认 5s 必超时。
  it(
    '稳态窗口高度精确钉在预算上,不随行滑动摆动(抖动回归)',
    () => {
      // 逐 delta 喂入折成多行的长中文段落(思考的典型形态)。内容填满预算后,
      // 窗口渲染高度必须恒等于 maxRows:按整行丢弃时,高度会随行滑动在几个
      // 值之间来回摆,粘底 scrollbox 里上方时间线整条跟着上下跳。
      const paras = Array.from(
        { length: 12 },
        (_, i) => `第${i}段:` + '这是一段模拟思考的长内容,没有任何换行符,会按终端宽度折成多个物理行。'.repeat(2),
      );
      const full = paras.join('\n\n');
      let acc = '';
      const heights: number[] = [];
      for (let i = 0; i < full.length; i += 3) {
        acc += full.slice(i, i + 3);
        // 纯 Text 渲染的行数 = 每行按宽度折行后的行数之和(输出里只有被截断
        // 的首行是预折行的,完整行仍靠渲染时折)。
        const out = tailWithinRows(acc, 5, 80, { markdown: false });
        heights.push(out.split('\n').reduce((n, line) => n + renderedRows(line, 80), 0));
      }
      const firstFull = heights.indexOf(5);
      expect(firstFull).toBeGreaterThan(0);
      for (const h of heights.slice(firstFull)) expect(h).toBe(5);
    },
    20_000,
  );

  it('markdown 模式围栏行按 0 行计,围栏滑过窗口高度不塌', () => {
    // 流式代码块:闭栏滑进窗口时,若围栏按 1 行计,窗口会瞬时矮一行。
    const full = '```\n' + Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    let acc = '';
    const heights: number[] = [];
    for (let i = 0; i < full.length; i += 2) {
      acc += full.slice(i, i + 2);
      heights.push(renderedHeight(tailWithinRows(acc, 5, 80), 80));
    }
    const firstFull = heights.indexOf(5);
    expect(firstFull).toBeGreaterThan(0);
    for (const h of heights.slice(firstFull)) expect(h).toBe(5);
  });

  it('markdown: false 不镜像 Markdown 变换:围栏行按普通行计,不补开栏', () => {
    const out = tailWithinRows('```\ncode line\n```', 2, 80, { markdown: false });
    expect(out).toBe('code line\n```');
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
