/**
 * 工具栏下拉菜单容器:锚定徽章下方的浮层,点击外部/Esc 关闭。滚动内容
 * 限高。纯展示,条目内容由使用者填。
 */

import React, { useEffect, useRef, useState } from 'react';

export function MenuPopover({
  label,
  title,
  children,
  width,
  requestOpen,
}: {
  /** 触发按钮的文案(徽章)。 */
  label: React.ReactNode;
  /** 菜单标题(可为空)。 */
  title?: string;
  children: React.ReactNode;
  width?: number;
  /** 外部触发打开(/models 命令):计数变化时打开。 */
  requestOpen?: number;
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
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
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
    <div className="menu-root" ref={rootRef}>
      <button type="button" className="toolbar-badge" onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open ? (
        <div className="menu-popover" style={width ? { width: `${width}px` } : undefined}>
          {title ? <div className="menu-title">{title}</div> : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}
