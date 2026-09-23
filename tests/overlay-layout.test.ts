import { describe, expect, it } from 'vitest';
import { overlayShown, resolveOverlayLayout } from '../src/ui/overlay-layout.js';

/**
 * `ui.custom(…, { overlay: true })` 的布局:Pi 形状的 OverlayOptions → 终端上的
 * 绝对矩形。纯函数,核心 lane 直接考;TUI 那边只管把结果放到 Box 上。
 */
describe('resolveOverlayLayout', () => {
  it('缺省:六成宽、居中、高度由内容撑', () => {
    const layout = resolveOverlayLayout({}, 100, 40);
    expect(layout.width).toBe(60);
    expect(layout.left).toBe(20);
    expect(layout.height).toBeUndefined();
    expect(layout.maxHeight).toBe(40);
    // 内容还没量(第一帧):只能按封顶算,居中就贴顶。
    expect(layout.top).toBe(0);
    // 没给高度就不带 height 键(直接展开到 Box 上,`height: undefined` 与不传不同)。
    expect('height' in layout).toBe(false);
  });

  it('没给 height 时按内容高度定位:居中真的居中,贴底的 toast 真的在底下', () => {
    const centered = resolveOverlayLayout({}, 100, 40, 10);
    expect(centered.height).toBeUndefined();
    expect(centered.top).toBe(15);
    const toast = resolveOverlayLayout({ anchor: 'bottom-right', width: 30 }, 100, 40, 7);
    expect([toast.left, toast.top]).toEqual([70, 33]);
    // 内容比可用区还高:按封顶算,不探出终端。
    const tall = resolveOverlayLayout({ anchor: 'bottom-center' }, 100, 40, 90);
    expect(tall.top).toBe(0);
  });

  it('百分比按终端算;min / max 夹住;margin 让出边缘', () => {
    const layout = resolveOverlayLayout(
      { width: '50%', minWidth: 60, height: '50%', maxHeight: 10, margin: 2 },
      100,
      40,
    );
    expect(layout.width).toBe(60);
    expect(layout.height).toBe(10);
    // 居中:可用区 96 列(两边各让 2),(96 - 60) / 2 = 18,再加左 margin。
    expect(layout.left).toBe(20);
    expect(layout.top).toBe(2 + Math.round((36 - 10) / 2));
  });

  it('九个锚点:角落贴边,offset 再挪', () => {
    const tl = resolveOverlayLayout({ width: 20, height: 5, anchor: 'top-left' }, 100, 40);
    expect([tl.left, tl.top]).toEqual([0, 0]);
    const br = resolveOverlayLayout({ width: 20, height: 5, anchor: 'bottom-right' }, 100, 40);
    expect([br.left, br.top]).toEqual([80, 35]);
    const rc = resolveOverlayLayout(
      { width: 20, height: 5, anchor: 'right-center', offsetX: -2, offsetY: 1 },
      100,
      40,
    );
    expect([rc.left, rc.top]).toEqual([78, 18 + 1]);
  });

  it('row / col 是绝对位置;超出终端的被夹回来', () => {
    const at = resolveOverlayLayout({ width: 20, height: 5, row: '25%', col: 10 }, 100, 40);
    expect([at.left, at.top]).toEqual([10, 10]);
    const far = resolveOverlayLayout({ width: 20, height: 5, row: 100, col: 200 }, 100, 40);
    expect([far.left, far.top]).toEqual([80, 35]);
  });

  it('极窄终端:margin 让掉、不算出负宽', () => {
    // margin 放不下就整对让掉:框绝不探出右沿与下沿。
    const tiny = resolveOverlayLayout({ width: 200, margin: 10 }, 12, 6);
    expect(tiny.left).toBeGreaterThanOrEqual(0);
    expect(tiny.left + tiny.width).toBeLessThanOrEqual(12);
    expect(tiny.top).toBeGreaterThanOrEqual(0);
    expect(tiny.top + tiny.maxHeight).toBeLessThanOrEqual(6);
    // 比最小内容还窄的终端:宽度退到终端宽,不算出负数。
    const sliver = resolveOverlayLayout({}, 3, 2);
    expect(sliver.width).toBe(3);
    expect(sliver.left).toBe(0);
  });

  it('overlayShown:画框与收键共用的判据——没 overlay、setHidden、visible 说不画都是 false', () => {
    expect(overlayShown({}, 100, 40)).toBe(false);
    expect(overlayShown({ overlay: {} }, 100, 40)).toBe(true);
    expect(overlayShown({ overlay: {}, hidden: true }, 100, 40)).toBe(false);
    expect(overlayShown({ overlay: { visible: (w) => w >= 80 } }, 60, 40)).toBe(false);
    // 函数形态的选项每次现取。
    let wide = false;
    const request = { overlay: () => ({ visible: () => wide }) };
    expect(overlayShown(request, 100, 40)).toBe(false);
    wide = true;
    expect(overlayShown(request, 100, 40)).toBe(true);
  });
});
