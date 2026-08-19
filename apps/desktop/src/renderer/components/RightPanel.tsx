/**
 * 右侧面板(设计稿):三 tab——变更(diff 审查 + 批准流)/ 终端(bash 流式
 * 输出)/ 文件(工作区文件树 + 预览)。⌘⌥B 切换显隐,右缘拖宽 240–720;
 * taskLayout='review' 时占满主区(Resizer 禁用)。
 *
 * 变更 tab:文件条单选列表 + 单文件 diff(语法高亮 + 行评论保留)+ 底部
 * 批准栏(批准并提交 → 已提交/撤销;请求修改 → Composer 预填;… 菜单里的
 * 丢弃走确认对话框,列出将被丢弃的清单)。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceFileEntrySummary, FileContentSummary } from '../../shared/ipc.js';
import { openPath, rpcCall, rpcFire } from '../bridge/invoke.js';
import { useReviewStore } from '../state/reviewStore.js';
import { useDesktopStore } from '../state/desktopStore.js';
import { usePanelStore } from '../state/panelStore.js';
import { useUiStore, type RightTab } from '../state/uiStore.js';
import { t, useLocale } from '../i18n/index.js';
import { DiffView, commentTargetOf, type ParsedDiffLine } from './DiffView.js';
import { Modal } from './overlays/Modal.js';
import { buildReviewComment } from '../utils/review-comment.js';
import { langOf } from '../utils/tokenize.js';
import { CHAT_MIN_WIDTH } from '../utils/sidebar.js';
import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretUpIcon,
  CheckCircleIcon,
  CheckIcon,
  CopyIcon,
  DotsThreeIcon,
  FileCodeIcon,
  FolderSimpleIcon,
  TrashIcon,
} from './icons.js';

const CHANGE_LABEL: Record<WorkspaceFileEntrySummary['change'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
};

/** 行下内嵌的评论输入(行评论能力保留自 Review 面板)。 */
function LineCommentInput({ path }: { path: string }) {
  const setCommentTarget = useReviewStore((s) => s.setCommentTarget);
  const target = useReviewStore((s) => s.commentTarget);
  const [value, setValue] = useState('');
  if (!target || target.path !== path) return null;

  const submit = () => {
    const comment = value.trim();
    if (!comment) return;
    const { text, display } = buildReviewComment({
      path: target.path,
      line: target.line,
      side: target.side,
      comment,
    });
    setValue('');
    setCommentTarget(undefined);
    // 统一走 run:运行中由 server 转 inject,空闲起新轮(loop.ts 的快速路径)。
    rpcFire({ kind: 'run', text, options: { display } }, { errorKey: 'notice.runFailed' });
  };

  return (
    <div className="line-comment">
      <input
        autoFocus
        value={value}
        placeholder={t('review.commentPlaceholder', { line: target.line })}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape') setCommentTarget(undefined);
        }}
      />
      <button type="button" className="btn-primary" disabled={!value.trim()} onClick={submit}>
        {t('review.commentSend')}
      </button>
      <button type="button" onClick={() => setCommentTarget(undefined)}>
        {t('review.commentCancel')}
      </button>
    </div>
  );
}

/** 丢弃确认对话框:列出将被丢弃的清单(字面语义:untracked 会被真删)。 */
function DiscardConfirm({ onClose }: { onClose: () => void }) {
  useLocale();
  const status = useReviewStore((s) => s.status);
  const discardAll = useReviewStore((s) => s.discardAll);
  return (
    <Modal variant="overlay" ariaLabel={t('panel.discardTitle')} onClose={onClose}>
      <div className="overlay-title">{t('panel.discardTitle')}</div>
      <div className="overlay-note">{t('panel.discardNote')}</div>
      <div className="overlay-list">
        {(status?.entries ?? []).map((entry) => (
          <div key={entry.path} className="overlay-list-row">
            <span className={`review-change review-change-${entry.change}`}>
              {CHANGE_LABEL[entry.change]}
            </span>
            <span className="overlay-list-path">{entry.path}</span>
          </div>
        ))}
      </div>
      <div className="overlay-actions">
        <button type="button" onClick={onClose}>
          {t('panel.discardCancel')}
        </button>
        <button
          type="button"
          className="btn-danger"
          onClick={() => {
            onClose();
            void discardAll();
          }}
        >
          {t('panel.discardConfirm')}
        </button>
      </div>
    </Modal>
  );
}

/** 底部批准栏:notApproved(批准并提交/请求修改)⇄ approved(已提交/撤销)。 */
function DiffApprovalBar() {
  useLocale();
  const approval = useReviewStore((s) => s.approval);
  const lastCommit = useReviewStore((s) => s.lastCommit);
  const approvalError = useReviewStore((s) => s.approvalError);
  const approve = useReviewStore((s) => s.approve);
  const undoApprove = useReviewStore((s) => s.undoApprove);
  const entries = useReviewStore((s) => s.status?.entries.length ?? 0);
  const running = useDesktopStore((s) => s.snapshot?.agent.isRunning ?? false);
  const requestPrefill = useDesktopStore((s) => s.requestComposerPrefill);
  const taskTitle = useDesktopStore(
    (s) => s.tasks?.find((task) => task.id === s.snapshot?.storeId)?.title,
  );
  const root = useDesktopStore((s) => s.snapshot?.root);
  const selectedPath = useReviewStore((s) => s.selectedPath);
  const selectedDiff = useReviewStore((s) =>
    s.selectedPath ? s.fileDiffs[s.selectedPath]?.diff : undefined,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);

  /** 复制为补丁:当前选中文件的 unified diff 进剪贴板。 */
  const copyPatch = () => {
    if (!selectedDiff) return;
    void navigator.clipboard?.writeText(selectedDiff).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  /** 在编辑器中打开:系统默认程序打开当前文件(绝对路径 = root + 相对路径)。 */
  const openInEditor = () => {
    if (!root || !selectedPath) return;
    openPath(`${root}/${selectedPath}`);
  };

  const committed = approval === 'committed';
  if (!committed && entries === 0) return null;

  return (
    <div className="approval-bar">
      {committed ? (
        <>
          <span className="approval-done">
            <CheckCircleIcon size={15} weight="fill" />
            {t('panel.committedTo', { branch: lastCommit?.branch ?? 'HEAD' })}
          </span>
          <button
            type="button"
            className="approval-undo"
            disabled={approval !== 'committed'}
            onClick={() => void undoApprove()}
          >
            {t('panel.undo')}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="btn-primary approval-approve"
            disabled={approval !== 'idle' || running}
            title={running ? t('panel.gitBusy') : undefined}
            onClick={() => void approve(taskTitle ? `${taskTitle}` : 'Approve pending changes')}
          >
            <CheckIcon size={13} />
            {approval === 'committing' ? t('panel.committing') : t('panel.approveCommit')}
          </button>
          <button
            type="button"
            className="approval-request"
            onClick={() => requestPrefill(t('panel.requestChangesPrefill'))}
          >
            {t('panel.requestChanges')}
          </button>
        </>
      )}
      {approvalError ? <span className="approval-error">{approvalError}</span> : null}
      <span className="toolbar-spacer" />
      <div className="approval-menu-root">
        <button type="button" className="review-icon" onClick={() => setMenuOpen(!menuOpen)}>
          <DotsThreeIcon size={16} />
        </button>
        {menuOpen ? (
          <div className="approval-menu">
            <button
              type="button"
              className="menu-item approval-menu-item"
              disabled={!selectedDiff}
              onClick={() => {
                setMenuOpen(false);
                copyPatch();
              }}
            >
              <CopyIcon size={14} />
              {t('panel.copyPatch')}
            </button>
            <button
              type="button"
              className="menu-item approval-menu-item"
              disabled={!selectedPath}
              onClick={() => {
                setMenuOpen(false);
                openInEditor();
              }}
            >
              <ArrowSquareOutIcon size={14} />
              {t('panel.openEditor')}
            </button>
            <div className="ctx-separator" />
            <button
              type="button"
              className="menu-item approval-menu-item"
              disabled={running}
              onClick={() => {
                setMenuOpen(false);
                setConfirming(true);
              }}
            >
              <TrashIcon size={14} />
              {t('panel.discardAll')}
            </button>
          </div>
        ) : null}
        {copied ? <span className="approval-copied">{t('panel.copied')}</span> : null}
      </div>
      {confirming ? <DiscardConfirm onClose={() => setConfirming(false)} /> : null}
    </div>
  );
}

/** 变更 tab:文件条单选 + 单文件 diff + 批准栏。 */
function DiffPane() {
  useLocale();
  const status = useReviewStore((s) => s.status);
  const unsupported = useReviewStore((s) => s.unsupported);
  const selectedPath = useReviewStore((s) => s.selectedPath);
  const selectFile = useReviewStore((s) => s.selectFile);
  const diff = useReviewStore((s) => (s.selectedPath ? s.fileDiffs[s.selectedPath] : undefined));
  const loading = useReviewStore((s) =>
    s.selectedPath ? (s.loadingPaths[s.selectedPath] ?? false) : false,
  );
  const setCommentTarget = useReviewStore((s) => s.setCommentTarget);
  const approval = useReviewStore((s) => s.approval);

  // 首个文件自动选中(设计稿:进面板即见 diff)。
  useEffect(() => {
    if (!selectedPath && status?.ok && status.entries.length > 0) {
      selectFile(status.entries[0]!.path);
    }
  }, [selectedPath, status, selectFile]);

  const onLineClick = (line: ParsedDiffLine) => {
    if (!selectedPath) return;
    const target = commentTargetOf(line);
    if (!target) return;
    setCommentTarget({ path: selectedPath, line: target.line, side: target.side });
  };

  if (unsupported) return <div className="review-degraded">{t('review.unsupported')}</div>;
  if (!status) return <div className="review-loading">{t('review.loading')}</div>;
  if (!status.ok) return <div className="review-degraded">{t('review.fail.no-repo')}</div>;
  if (status.entries.length === 0 && approval !== 'committed') {
    return <div className="review-empty">{t('review.clean')}</div>;
  }

  return (
    <div className="diff-pane">
      <div className="diff-files">
        {status.entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className={`diff-file-row ${entry.path === selectedPath ? 'diff-file-active' : ''}`}
            onClick={() => selectFile(entry.path)}
          >
            <FileCodeIcon size={13} />
            <span className="diff-file-name" title={entry.path}>
              {entry.path}
            </span>
            {entry.additions !== undefined || entry.deletions !== undefined ? (
              <span className="review-stat">
                <span className="diff-add">+{entry.additions ?? 0}</span>{' '}
                <span className="diff-del">−{entry.deletions ?? 0}</span>
              </span>
            ) : null}
          </button>
        ))}
        {status.truncated ? <div className="review-degraded">{t('review.truncated')}</div> : null}
      </div>
      <div className="diff-scroll">
        {loading && !diff ? <div className="review-loading">{t('review.loading')}</div> : null}
        {diff?.ok && diff.diff !== undefined ? (
          <>
            <DiffView
              diff={diff.diff}
              showLineNumbers
              hideMeta
              showStat={false}
              onLineClick={onLineClick}
              highlight={langOf(selectedPath)}
            />
            {selectedPath ? <LineCommentInput path={selectedPath} /> : null}
          </>
        ) : null}
        {diff && !diff.ok ? (
          <div className="review-degraded">
            {t(`review.fail.${diff.reason ?? 'git-error'}` as 'review.fail.binary')}
          </div>
        ) : null}
      </div>
      <DiffApprovalBar />
    </div>
  );
}

/** 终端 tab:bash 流式输出(panelStore 的 per-task ring buffer),粘底滚动。 */
function TerminalPane() {
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

interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[];
}

/** 扁平路径 → 目录树(目录在前,字典序)。 */
export function buildFileTree(paths: string[]): TreeNode[] {
  interface Dir {
    dirs: Map<string, Dir>;
    files: string[];
    path: string;
  }
  const root: Dir = { dirs: new Map(), files: [], path: '' };
  for (const path of paths) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!;
      let next = dir.dirs.get(name);
      if (!next) {
        next = { dirs: new Map(), files: [], path: dir.path ? `${dir.path}/${name}` : name };
        dir.dirs.set(name, next);
      }
      dir = next;
    }
    dir.files.push(parts[parts.length - 1]!);
  }
  const toNodes = (dir: Dir): TreeNode[] => [
    ...[...dir.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, sub]) => ({ name, path: sub.path, children: toNodes(sub) })),
    ...dir.files
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, path: dir.path ? `${dir.path}/${name}` : name })),
  ];
  return toNodes(root);
}

/** 文件 tab:惰性 listFiles 组树 + changedFiles badge + 点文件预览。 */
function FileTreePane() {
  useLocale();
  const changedFiles = useDesktopStore((s) => s.snapshot?.changedFiles);
  const [files, setFiles] = useState<string[] | undefined>();
  const [error, setError] = useState(false);
  const [openDirs, setOpenDirs] = useState<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = useState<FileContentSummary | undefined>();

  useEffect(() => {
    void rpcCall({ kind: 'listFiles' })
      .then((result) => setFiles(result.files))
      .catch(() => setError(true));
  }, []);

  const tree = useMemo(() => buildFileTree(files ?? []), [files]);
  const changedMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of changedFiles ?? []) map.set(entry.path, entry.count);
    return map;
  }, [changedFiles]);

  const openFile = (path: string) => {
    void rpcCall({ kind: 'readFile', path })
      .then(setPreview)
      .catch(() => setPreview({ ok: false, reason: 'not-found', path, size: 0, truncated: false }));
  };

  if (error) return <div className="review-degraded">{t('files.unsupported')}</div>;
  if (!files) return <div className="review-loading">{t('review.loading')}</div>;

  if (preview) {
    return (
      <div className="file-preview">
        <div className="file-preview-head">
          <button type="button" className="review-icon" onClick={() => setPreview(undefined)}>
            ←
          </button>
          <span className="file-preview-path">{preview.path}</span>
        </div>
        {preview.ok ? (
          <pre className="file-preview-body">{preview.content}</pre>
        ) : (
          <div className="review-degraded">
            {t(`files.fail.${preview.reason ?? 'not-found'}` as 'files.fail.binary')}
          </div>
        )}
      </div>
    );
  }

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const pad = 9 + depth * 16;
      if (node.children) {
        const open = openDirs.has(node.path);
        return (
          <React.Fragment key={node.path}>
            <button
              type="button"
              className="tree-row"
              style={{ paddingLeft: `${pad}px` }}
              onClick={() =>
                setOpenDirs((prev) => {
                  const next = new Set(prev);
                  if (next.has(node.path)) next.delete(node.path);
                  else next.add(node.path);
                  return next;
                })
              }
            >
              <FolderSimpleIcon size={13} />
              <span className="tree-name">{node.name}</span>
              <span className="tree-caret">{open ? <CaretUpIcon size={11} /> : <CaretDownIcon size={11} />}</span>
            </button>
            {open ? renderNodes(node.children, depth + 1) : null}
          </React.Fragment>
        );
      }
      const changed = changedMap.get(node.path);
      return (
        <button
          key={node.path}
          type="button"
          className={`tree-row ${changed ? 'tree-row-changed' : ''}`}
          style={{ paddingLeft: `${pad}px` }}
          onClick={() => openFile(node.path)}
        >
          <FileCodeIcon size={13} />
          <span className="tree-name">{node.name}</span>
          {changed ? <span className="tree-badge">+{changed}</span> : null}
        </button>
      );
    });

  return <div className="file-tree">{renderNodes(tree, 0)}</div>;
}

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
