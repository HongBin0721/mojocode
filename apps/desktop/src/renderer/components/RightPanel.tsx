/**
 * 右侧面板(设计稿)——外壳:三 tab(变更/终端/文件,各自在 panel/ 子目录)
 * 的分发、header、拖宽 Resizer。⌘⌥B 切换显隐,右缘拖宽 240–720;
 * taskLayout='review' 时占满主区(Resizer 禁用)。
 */

import React, { useEffect, useRef, useState } from 'react';
import { useReviewStore } from '../state/reviewStore.js';
import { useUiStore, type RightTab } from '../state/uiStore.js';
import { t, useLocale } from '../i18n/index.js';
import { CHAT_MIN_WIDTH } from '../utils/sidebar.js';
import { DiffPane } from './panel/DiffPane.js';
import { TerminalPane } from './panel/TerminalPane.js';
import { FileTreePane } from './panel/FileTreePane.js';

// 兼容 re-export:树算法已迁 utils/file-tree.ts(tests/components/right-panel
// 等旧调用方从本文件具名导入)。
export { buildFileTree } from '../utils/file-tree.js';

/** 拖宽分隔条:拖动改 flex-basis(240–720px)。 */
function Resizer({ onDrag }: { onDrag: (deltaX: number) => void }) {
  const lastX = useRef(0);
  return (
    <div
      className="review-resizer"
      onMouseDown={(e) => {
        lastX.current = e.clientX;
        const move = (ev: MouseEvent) => {
          onDrag(ev.clientX - lastX.current);
          lastX.current = ev.clientX;
        };
        const up = () => {
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

const TABS: Array<{ id: RightTab; labelKey: 'panel.tabDiff' | 'panel.tabTerminal' | 'panel.tabFiles' }> = [
  { id: 'diff', labelKey: 'panel.tabDiff' },
  { id: 'terminal', labelKey: 'panel.tabTerminal' },
  { id: 'files', labelKey: 'panel.tabFiles' },
];

export function RightPanel() {
  useLocale();
  const visible = useReviewStore((s) => s.visible);
  const status = useReviewStore((s) => s.status);
  const unsupported = useReviewStore((s) => s.unsupported);
  const toggleVisible = useReviewStore((s) => s.toggleVisible);
  const refresh = useReviewStore((s) => s.refresh);
  const rightTab = useUiStore((s) => s.rightTab);
  const setRightTab = useUiStore((s) => s.setRightTab);
  const fullWidth = useUiStore((s) => s.taskLayout === 'review');
  const [width, setWidth] = useState(480);

  // Cmd/Ctrl+Option+B 切换(文档级监听,textarea 之外也能触发)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggleVisible();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleVisible]);

  // 窗口 focus 时刷新(pending 变更可能在 GUI 之外发生)。
  useEffect(() => {
    const onFocus = () => {
      if (useReviewStore.getState().visible) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  // 挂载即拉一次:visible 从 localStorage 恢复(应用启动)不经过 setVisible
  // 的刷新路径,首屏要自己补。
  useEffect(() => {
    const { visible: shown, status, unsupported } = useReviewStore.getState();
    if (shown && status === undefined && !unsupported) void refresh();
  }, [refresh]);

  if (!visible && !fullWidth) return null;

  const diffStat =
    status?.ok && status.entries.length > 0
      ? `${status.entries.length} · +${status.additions} −${status.deletions}`
      : t('panel.noChanges');

  return (
    <div
      className={`right-panel ${fullWidth ? 'right-panel-full' : ''}`}
      style={fullWidth ? undefined : { flexBasis: `${width}px` }}
    >
      {!fullWidth ? (
        <Resizer
          onDrag={(delta) =>
            setWidth((w) => {
              // 上限:240..720 之外还要给中间区留 CHAT_MIN_WIDTH(侧栏实宽现量,
              // 含折叠态);窗口极窄时上限压不过 240 下限——CSS 端由面板先收缩兜底。
              const sidebar =
                document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0;
              const limit = Math.max(
                240,
                Math.min(720, window.innerWidth - sidebar - CHAT_MIN_WIDTH),
              );
              return Math.min(limit, Math.max(240, w - delta));
            })
          }
        />
      ) : null}
      <div className="panel-header">
        <div className="panel-tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`panel-tab ${rightTab === tab.id ? 'panel-tab-active' : ''}`}
              onClick={() => setRightTab(tab.id)}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
        <span className="toolbar-spacer" />
        {!unsupported ? <span className="panel-stat">{diffStat}</span> : null}
        <button type="button" className="review-icon" title={t('review.refresh')} onClick={() => void refresh()}>
          ⟳
        </button>
        <button type="button" className="review-icon" title={t('review.close')} onClick={toggleVisible}>
          ×
        </button>
      </div>
      <div className="panel-body">
        {rightTab === 'diff' ? <DiffPane /> : rightTab === 'terminal' ? <TerminalPane /> : <FileTreePane />}
      </div>
    </div>
  );
}
