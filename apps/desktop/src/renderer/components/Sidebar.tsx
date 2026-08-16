/**
 * 侧栏(Codex 三层形态的本地单环境退化):项目头(root 尾段)→ 环境组头
 * 「本地会话」→ thread 列表(= session,标题/相对时间/running 徽章/当前
 * 高亮)。「环境」层为将来的 worktree 并行预留结构位。
 */

import React from 'react';
import type { SessionMetaSummary } from '../../shared/ipc.js';
import { useDesktopStore } from '../state/desktopStore.js';
import { t, useLocale } from '../i18n/index.js';

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return 'now';
  if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3600_000)}h`;
  return date.toLocaleDateString();
}

function ThreadRow({ session, active, running }: { session: SessionMetaSummary; active: boolean; running: boolean }) {
  const onOpen = () => {
    void window.mojocode.rpc({ kind: 'resumeSession', idOrPrefix: session.id }).catch((error) => {
      console.error('resume 失败', error);
    });
  };
  return (
    <button type="button" className={`session-row ${active ? 'session-active' : ''}`} onClick={onOpen}>
      <span className="session-line">
        {running ? <span className="session-running-dot" title={t('badge.running')} /> : null}
        <span className="session-title">{session.title || session.id.slice(0, 8)}</span>
      </span>
      <span className="session-meta">
        {formatWhen(session.updatedAt)} · {session.messageCount}
      </span>
    </button>
  );
}

export function Sidebar() {
  useLocale();
  const sessions = useDesktopStore((s) => s.sessions);
  const snapshot = useDesktopStore((s) => s.snapshot);
  const storeId = snapshot?.storeId;
  const running = snapshot?.agent.isRunning ?? false;
  const project = snapshot?.root.split('/').filter(Boolean).at(-1) ?? '';

  const newSession = () => {
    if (running) return;
    void window.mojocode.rpc({ kind: 'newSession' }).catch((error) => {
      console.error('newSession 失败', error);
    });
  };

  return (
    <aside className="sidebar">
      <div className="project-header" title={snapshot?.root}>
        <span className="project-name">{project || '~'}</span>
      </div>
      <div className="env-group">
        <span className="env-group-label">{t('sidebar.envLocal')}</span>
        <button
          type="button"
          className="new-session"
          onClick={newSession}
          disabled={running}
          title={running ? t('sidebar.busy') : undefined}
        >
          +
        </button>
      </div>
      <div className="session-list">
        {sessions === undefined ? (
          <div className="sidebar-empty">{t('sidebar.unsupported')}</div>
        ) : sessions.length === 0 ? (
          <div className="sidebar-empty">{t('sidebar.empty')}</div>
        ) : (
          sessions.map((session) => (
            <ThreadRow
              key={session.id}
              session={session}
              active={session.id === storeId}
              running={session.id === storeId && running}
            />
          ))
        )}
      </div>
    </aside>
  );
}
