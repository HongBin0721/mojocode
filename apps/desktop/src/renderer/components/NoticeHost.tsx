/**
 * 全局 toast 宿主(App 根挂载,右下角堆叠)。样式内联:本轮重构不动
 * styles/ 目录(级联顺序是既有约束),小组件自含即可;颜色引用 tokens.less
 * 的运行时 CSS 变量,换肤自动跟随。role="status" 供测试与读屏定位。
 */

import type { CSSProperties } from 'react';
import { useNoticeStore, type Notice } from '../state/noticeStore.js';

const hostStyle: CSSProperties = {
  position: 'fixed',
  right: 16,
  bottom: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  zIndex: 100, // 高于 .select-menu(80):toast 是纯展示,不参与浮层仲裁
  pointerEvents: 'none',
};

const LEVEL_COLOR: Record<Notice['level'], string> = {
  info: 'var(--color-foreground-soft)',
  warn: 'var(--color-warning)',
  error: 'var(--color-destructive-soft)',
};

function cardStyle(level: Notice['level']): CSSProperties {
  return {
    maxWidth: 420,
    padding: '10px 14px',
    borderRadius: 'var(--radius-lg)',
    background: 'var(--color-popover)',
    border: '1px solid var(--color-border-strong)',
    boxShadow: 'var(--shadow-pop)',
    color: LEVEL_COLOR[level],
    fontSize: 13,
    lineHeight: 1.5,
    wordBreak: 'break-word',
    pointerEvents: 'auto',
    cursor: 'pointer',
  };
}

export function NoticeHost(): React.JSX.Element | null {
  const notices = useNoticeStore((state) => state.notices);
  const dismiss = useNoticeStore((state) => state.dismiss);
  if (notices.length === 0) return null;
  return (
    <div style={hostStyle} role="status" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} style={cardStyle(notice.level)} onClick={() => dismiss(notice.id)}>
          {notice.message}
        </div>
      ))}
    </div>
  );
}
