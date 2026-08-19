/**
 * 终端 tab(自 RightPanel.tsx 拆出):bash 流式输出(panelStore 的 per-task
 * ring buffer),粘底滚动。
 */

import React, { useEffect, useRef } from 'react';
import { useDesktopStore } from '../../state/desktopStore.js';
import { usePanelStore } from '../../state/panelStore.js';
import { t, useLocale } from '../../i18n/index.js';

export function TerminalPane() {
  useLocale();
  const taskId = useDesktopStore((s) => s.focusedTaskId);
  const terminal = usePanelStore((s) => (taskId ? s.terminals[taskId] : undefined));
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [terminal]);

  const lines = terminal?.lines ?? [];
  return (
    <div className="terminal-pane" ref={scrollRef}>
      {lines.length === 0 && !terminal?.partial ? (
        <div className="terminal-empty">{t('terminal.empty')}</div>
      ) : (
        <>
          {lines.map((line, index) => (
            <div key={index} className={`terminal-line terminal-${line.kind}`}>
              {line.text || ' '}
            </div>
          ))}
          {terminal?.partial ? <div className="terminal-line terminal-out">{terminal.partial}</div> : null}
        </>
      )}
    </div>
  );
}
