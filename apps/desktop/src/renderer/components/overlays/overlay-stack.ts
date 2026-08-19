/**
 * 浮层栈:Esc 层级仲裁的唯一机制,取代「捕获相先注册先触发 + querySelector
 * ('.select-menu') 哨兵让位」的旧协议(那套依赖监听注册顺序与 CSS 类名,
 * 两者都脆——`.select-menu` 从此只是样式类)。
 *
 * 语义:后开的浮层在栈顶,只有栈顶响应 Esc(处理后 stopPropagation,事件
 * 到不了外层的捕获/冒泡监听)。模块级栈、与 React 解耦:测试可以命令式
 * acquire/release,不必往 DOM 里插哨兵节点。
 */

import { useEffect, useRef } from 'react';

export interface OverlayLayer {
  /** 当前是否栈顶(Esc 只归栈顶)。 */
  isTop(): boolean;
  /** 出栈(幂等)。 */
  release(): void;
}

const stack: symbol[] = [];

/** 命令式入栈(hook 之外的场景与测试用)。 */
export function acquireOverlayLayer(): OverlayLayer {
  const token = Symbol('overlay-layer');
  stack.push(token);
  return {
    isTop: () => stack[stack.length - 1] === token,
    release: () => {
      const index = stack.indexOf(token);
      if (index !== -1) stack.splice(index, 1);
    },
  };
}

/** 仅测试用:防用例间串栈。 */
export function resetOverlayStackForTest(): void {
  stack.length = 0;
}

/**
 * hook 包装:open 为 true 时入栈,关闭/卸载时出栈。返回的 isTop 是活引用
 * (每次调用现查栈),渲染期不订阅——Esc 处理器在事件回调里调用它。
 */
export function useOverlayLayer(open: boolean): OverlayLayer {
  const layerRef = useRef<OverlayLayer | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    const layer = acquireOverlayLayer();
    layerRef.current = layer;
    return () => {
      layer.release();
      layerRef.current = undefined;
    };
  }, [open]);
  return {
    isTop: () => layerRef.current?.isTop() ?? false,
    release: () => layerRef.current?.release(),
  };
}
