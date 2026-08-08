import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { meterBar, modeChipColors } from '../src/ui/theme.js';

describe('上下文计量条', () => {
  it('宽度恒定,与格数一致', () => {
    for (const ratio of [0, 0.01, 0.5, 0.999, 1, 2, -1, NaN]) {
      const { filled, empty } = meterBar(ratio, 8);
      expect(stringWidth(filled + empty), `ratio=${ratio}`).toBe(8);
    }
  });

  it('用掉一点就点亮第一格,没满就不画满', () => {
    expect(meterBar(0, 8).filled).toBe('');
    // 0.5% 四舍五入是 0 格,但"用了"和"没用"必须看得出区别。
    expect(meterBar(0.005, 8).filled).toHaveLength(1);
    expect(meterBar(0.999, 8).filled).toHaveLength(7);
    expect(meterBar(1, 8).filled).toHaveLength(8);
  });

  it('中段按比例四舍五入', () => {
    expect(meterBar(0.5, 8).filled).toHaveLength(4);
    expect(meterBar(0.23, 8).filled).toHaveLength(2);
    expect(meterBar(0.9, 8).filled).toHaveLength(7);
  });
});

describe('权限档位徽章配色', () => {
  it('前景与背景都显式给出,不依赖终端默认色', () => {
    for (const mode of ['ask', 'plan', 'read-only', 'full-access', 'danger-full-access']) {
      const { bg, fg } = modeChipColors(mode);
      expect(bg, mode).toMatch(/^#[0-9a-f]{6}$/);
      expect(fg, mode).toMatch(/^#[0-9a-f]{6}$/);
      expect(bg).not.toBe(fg);
    }
  });

  it('危险档位单独一种底色,与常规档不同', () => {
    const danger = modeChipColors('full-access').bg;
    expect(modeChipColors('danger-full-access').bg).toBe(danger);
    expect(modeChipColors('ask').bg).not.toBe(danger);
    expect(modeChipColors('plan').bg).not.toBe(danger);
    expect(modeChipColors('read-only').bg).not.toBe(danger);
  });
});
