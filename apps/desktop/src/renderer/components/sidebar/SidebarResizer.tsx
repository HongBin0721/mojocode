/** 右缘拖宽手柄(自 Sidebar.tsx 拆出):拖动钳制 264~50vw,双击复位,松手落盘。 */

import React, { useState } from 'react';
import { useUiStore } from '../../state/uiStore.js';

export function SidebarResizer() {
  const setWidth = useUiStore((s) => s.setWidth);
  const commitWidth = useUiStore((s) => s.commitWidth);
  const resetWidth = useUiStore((s) => s.resetWidth);
  const [dragging, setDragging] = useState(false);

  return (
    <div
      className={`sidebar-resizer ${dragging ? 'sidebar-resizer-active' : ''}`}
      onDoubleClick={resetWidth}
      onMouseDown={(e) => {
        // 宽度 = 手柄 X - 侧栏左缘(手柄贴侧栏右缘,随宽度移动)。
        const sidebarLeft = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
        // 右面板占宽按下时量一次(拖侧栏时它不变):上限要给中间区留最小宽。
        const reserved =
          document.querySelector('.right-panel:not(.right-panel-full)')?.getBoundingClientRect()
            .width ?? 0;
        setDragging(true);
        const move = (ev: MouseEvent) => {
          setWidth(ev.clientX - sidebarLeft, window.innerWidth, reserved);
        };
        const up = () => {
          setDragging(false);
          commitWidth();
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.style.cursor = '';
        };
        document.body.style.cursor = 'col-resize';
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      }}
    />
  );
}
