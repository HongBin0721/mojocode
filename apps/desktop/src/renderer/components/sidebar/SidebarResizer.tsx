/** 右缘拖宽手柄(自 Sidebar.tsx 拆出):拖动钳制 264~50vw,双击复位,松手落盘。 */

import React, { useState } from 'react';
import { useUiStore } from '../../state/uiStore.js';
import { useReviewStore } from '../../state/reviewStore.js';

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
        // 右面板占宽按下时读一次(拖侧栏时它不变):上限要给中间区留最小宽。
        // 从 store 读而非量 DOM——面板挂载条件(task 视图 + chat 布局 +
        // review 可见)与它的渲染条件一一对应,类名不再是隐式契约。
        const ui = useUiStore.getState();
        const panelMounted =
          ui.view === 'task' && ui.taskLayout === 'chat' && useReviewStore.getState().visible;
        const reserved = panelMounted ? ui.panelWidth : 0;
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
