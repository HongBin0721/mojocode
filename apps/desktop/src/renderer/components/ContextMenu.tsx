/**
 * 通用右键菜单:全屏捕获层(点击/右键/滚动关闭)+ fixed 定位的菜单卡,
 * portal 到 body。Esc 在捕获阶段处理并 stopPropagation——只关自己;
 * 更内层的浮层(Select 的 .select-menu)存在时让位,与 ModelModal 同款守卫。
 */

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** 该项之前渲染一条分隔线。 */
  separatorBefore?: boolean;
  danger?: boolean;
  disabled?: boolean;
}

export function ContextMenu({
  x,
  y,
  title,
  items,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  title?: string;
  items: ContextMenuItem[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // 更内层的浮层自己处理 Esc(与 ModelModal 的 .select-menu 守卫同理)。
      if (document.querySelector('.select-menu')) return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // 视口钳制:菜单不越出右/下缘(粗略按最大尺寸估算)。
  const left = Math.min(x, Math.max(0, window.innerWidth - 220));
  const top = Math.min(y, Math.max(0, window.innerHeight - 40 - items.length * 34));

  return createPortal(
    <div
      className="ctx-capture"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className="ctx-menu"
        role="menu"
        style={{ left: `${left}px`, top: `${top}px` }}
        onClick={(e) => e.stopPropagation()}
      >
        {title ? <div className="ctx-title">{title}</div> : null}
        {items.map((item) => (
          <React.Fragment key={item.id}>
            {item.separatorBefore ? <div className="ctx-separator" /> : null}
            <button
              type="button"
              role="menuitem"
              className={`ctx-item ${item.danger ? 'ctx-item-danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                onClose();
                onPick(item.id);
              }}
            >
              {item.icon ? <span className="ctx-icon">{item.icon}</span> : null}
              {item.label}
            </button>
          </React.Fragment>
        ))}
      </div>
    </div>,
    document.body,
  );
}
