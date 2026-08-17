/**
 * portal 到 body 的 fixed 浮层定位骨架,Select(表单选择器)与 CascadeMenu
 * (级联二级卡)共用:打开后首帧浮层以 `visibility:hidden` 渲染,量完锚点与
 * 自身的真实矩形,交 `compute` 算落点,再统一夹回视口(8px 边距;jsdom 里
 * 矩形全 0,退化到左上角,不影响行为断言);外部滚动(捕获相,浮层自身滚动
 * 除外)回调 `onOutsideScroll`——fixed 定位不跟随锚点,滚动只能收起。
 * 几何策略(当前项覆盖触发器 / 右弹翻左)与关闭语义(即关 / 悬停延时)
 * 留在各组件,这里只管定位机制。
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface AnchoredPos {
  top: number;
  left: number;
}

export function useAnchoredPortal<T extends AnchoredPos>(options: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  overlayRef: RefObject<HTMLElement | null>;
  /** 由锚点/浮层矩形算原始落点;额外字段(如 minWidth)原样透传进返回值。 */
  compute: (anchor: DOMRect, overlay: DOMRect, overlayEl: HTMLElement) => T;
  onOutsideScroll: () => void;
}): T | undefined {
  const { open, anchorRef, overlayRef } = options;
  const [pos, setPos] = useState<T | undefined>();
  // 回调走 ref:effect 只随 open 注册一次,又不想捕获过期闭包。
  const computeRef = useRef(options.compute);
  computeRef.current = options.compute;
  const scrollRef = useRef(options.onOutsideScroll);
  scrollRef.current = options.onOutsideScroll;

  useLayoutEffect(() => {
    if (!open) {
      setPos(undefined);
      return;
    }
    const anchor = anchorRef.current;
    const overlay = overlayRef.current;
    if (!anchor || !overlay) return;
    const overlayRect = overlay.getBoundingClientRect();
    const raw = computeRef.current(anchor.getBoundingClientRect(), overlayRect, overlay);
    setPos({
      ...raw,
      top: Math.min(Math.max(raw.top, 8), Math.max(window.innerHeight - overlayRect.height - 8, 8)),
      left: Math.min(Math.max(raw.left, 8), Math.max(window.innerWidth - overlayRect.width - 8, 8)),
    });
    // anchorRef/overlayRef 是稳定的 ref 容器,量测只该在开合时发生。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && overlayRef.current?.contains(event.target)) return;
      scrollRef.current();
    };
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return pos;
}
