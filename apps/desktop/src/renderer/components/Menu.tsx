/**
 * 下拉菜单容器:锚定触发器旁的浮层,点击外部/Esc 关闭。滚动内容限高。
 * 纯展示,条目内容由使用者填。placement 决定向下(默认,侧栏等顶部位置)
 * 还是向上(Composer 工具栏,菜单得朝输入框上方弹)。
 */

import React, { useEffect, useRef, useState } from 'react';

/** 菜单内容拿来关掉自己的出口:点选条目后即关(ZCode 行为)。 */
export const MenuCloseContext = React.createContext<() => void>(() => {});

export function MenuPopover({
  label,
  title,
  children,
  width,
  requestOpen,
  placement = 'bottom',
  align = 'start',
  block = false,
}: {
  /** 触发按钮的文案(徽章)。 */
  label: React.ReactNode;
  /** 菜单标题(可为空)。 */
  title?: string;
  children: React.ReactNode;
  width?: number;
  /** 外部触发打开(/models 命令):计数变化时打开。 */
  requestOpen?: number;
  /** 浮层弹出方向:bottom 在触发器下方(默认),top 在上方。 */
  placement?: 'bottom' | 'top';
  /** 水平锚定:start 左对齐触发器(默认),end 右对齐——靠近窗口右缘的
   * 触发器(模型/思考强度)必须 end,否则窄窗口下弹层伸出视口。 */
  align?: 'start' | 'end';
  /** 触发器铺满容器宽(侧栏底部的整宽设置行)。 */
  block?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (requestOpen !== undefined && requestOpen > 0) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 计数变化即意图。
  }, [requestOpen]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      // portal 出去的次级浮层(级联菜单的二级)不算"外部":它挂在 body 上,
      // contains 测不到,不放行会在 click 送达前把整个菜单卸载、吞掉点选。
      if (target.closest?.('[data-menu-portal]')) return;
      if (rootRef.current && !rootRef.current.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`menu-root ${block ? 'menu-root-block' : ''}`} ref={rootRef}>
      <button
        type="button"
        className={`menu-trigger ${block ? 'menu-trigger-block' : ''}`}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open ? (
        <div
          className={`menu-popover ${placement === 'top' ? 'menu-popover-up' : ''} ${
            align === 'end' ? 'menu-popover-end' : ''
          }`}
          style={width ? { width: `${width}px` } : undefined}
        >
          {title ? <div className="menu-title">{title}</div> : null}
          <MenuCloseContext.Provider value={() => setOpen(false)}>{children}</MenuCloseContext.Provider>
        </div>
      ) : null}
    </div>
  );
}
