import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { logoGradient, pixelLogoWidth, renderPixelLogo } from '../src/ui/logo.js';

describe('像素字 logo', () => {
  it('5 行像素压成 3 行文本,每行宽度与 pixelLogoWidth 一致', () => {
    const rows = renderPixelLogo('mojocode');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const line = row.join('');
      // 半块字符必须是单宽的:一旦某个终端按双宽算,整块字就会错位。
      expect(stringWidth(line)).toBe(pixelLogoWidth('mojocode'));
      expect(line).toHaveLength(pixelLogoWidth('mojocode'));
    }
  });

  it('按字符切段,便于逐字上色', () => {
    const rows = renderPixelLogo('abc');
    for (const row of rows) {
      expect(row).toHaveLength(3);
      // 前两段带 1 列间隙,末段不带。
      expect(row[0]).toHaveLength(6);
      expect(row[2]).toHaveLength(5);
    }
  });

  it('大小写同形,未知字符退化成空白而不抛错', () => {
    expect(renderPixelLogo('M')).toEqual(renderPixelLogo('m'));
    const rows = renderPixelLogo('¥');
    expect(rows.every((r) => r.join('').trim() === '')).toBe(true);
  });

  it('渐变色按字符数插值,端点固定', () => {
    const g = logoGradient(8);
    expect(g).toHaveLength(8);
    expect(g[0]).toBe('#5eead4');
    expect(g[7]).toBe('#818cf8');
    expect(g.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
    expect(logoGradient(1)).toEqual(['#5eead4']);
    expect(logoGradient(0)).toEqual([]);
  });

  it('空文本没有宽度', () => {
    expect(pixelLogoWidth('')).toBe(0);
  });
});
