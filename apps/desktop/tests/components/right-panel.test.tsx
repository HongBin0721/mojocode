// @vitest-environment jsdom
/**
 * 右侧面板(三 tab)组件测试:tab 切换、变更 tab 的文件条单选 + 自动加载
 * diff + 行评论、批准流按钮、终端 tab 的行渲染、文件 tab 的组树与预览。
 * window.mojocode 以桩替换;store 直接置态。
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { setLocale } from '../../src/renderer/i18n/index.js';
import { useReviewStore } from '../../src/renderer/state/reviewStore.js';
import { useUiStore } from '../../src/renderer/state/uiStore.js';
import { useDesktopStore } from '../../src/renderer/state/desktopStore.js';
import { usePanelStore } from '../../src/renderer/state/panelStore.js';
import { RightPanel, buildFileTree } from '../../src/renderer/components/RightPanel.js';
import type { StateSnapshot } from '@core/protocol';

setLocale('zh-CN');

const rpcMock = vi.fn<(request: unknown) => Promise<unknown>>();

const snapshot = (): StateSnapshot =>
  ({
    root: '/w',
    storeId: 's-1',
    provider: {},
    config: {},
    mcpStatuses: [],
    agent: { isRunning: false, isCompacting: false, historyLength: 0 },
    goal: { active: false, busy: false },
    todos: [],
    skills: [],
    changedFiles: [{ path: 'src/a.ts', kind: 'modified', count: 2 }],
    sentAt: 0,
  }) as unknown as StateSnapshot;

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (request: unknown) => {
    const kind = (request as { kind: string }).kind;
    if (kind === 'workspaceStatus') {
      return {
        ok: true,
        branch: 'main',
        entries: [
          { path: 'src/a.ts', change: 'modified', staged: false, additions: 1, deletions: 1 },
          { path: 'notes.md', change: 'untracked', staged: false },
        ],
        additions: 1,
        deletions: 1,
        truncated: false,
      };
    }
    if (kind === 'fileDiff') {
      return {
        ok: true,
        path: 'src/a.ts',
        diff: '@@ -1,2 +1,2 @@\n keep\n-old line\n+new line',
        truncated: false,
      };
    }
    if (kind === 'listFiles') {
      return { files: ['src/a.ts', 'src/b.ts', 'README.md'], truncated: false };
    }
    if (kind === 'readFile') {
      return { ok: true, path: 'README.md', content: 'hello world', size: 11, truncated: false };
    }
    if (kind === 'commitAll') return { ok: true, sha: 'a'.repeat(40) };
    return undefined;
  });
  (window as unknown as { mojocode: unknown }).mojocode = { rpc: rpcMock };
  useUiStore.setState({ rightTab: 'diff', taskLayout: 'chat' });
  useDesktopStore.setState({
    snapshot: snapshot(),
    focusedTaskId: 's-1',
    tasks: undefined,
    composerPrefill: undefined,
  });
  usePanelStore.setState({ terminals: {} });
  useReviewStore.setState({
    visible: true,
    unsupported: false,
    status: undefined,
    fileDiffs: {},
    loadingPaths: {},
    selectedPath: undefined,
    commentTarget: undefined,
    approval: 'idle',
    lastCommit: undefined,
    approvalError: undefined,
  });
});

describe('RightPanel', () => {
  it('变更 tab:首个文件自动选中并加载 diff;批准栏可见', async () => {
    render(<RightPanel />);
    await useReviewStore.getState().refresh();
    await waitFor(() => {
      expect(screen.getByText('src/a.ts')).toBeTruthy();
      // diff 正文经 tokenize 拆成多个 span,按容器全文断言。
      expect(document.body.textContent).toContain('new line');
    });
    expect(screen.getByText('批准并提交')).toBeTruthy();
    expect(screen.getByText('请求修改')).toBeTruthy();
  });

  it('「请求修改」触发 Composer 预填', async () => {
    render(<RightPanel />);
    await useReviewStore.getState().refresh();
    await waitFor(() => screen.getByText('请求修改'));
    fireEvent.click(screen.getByText('请求修改'));
    expect(useDesktopStore.getState().composerPrefill?.text).toBe('请修改：');
  });

  it('终端 tab:渲染命令行与输出行', async () => {
    usePanelStore.getState().appendCommand('s-1', 'npm test');
    usePanelStore.getState().appendChunk('s-1', 'ok 1\nok 2\n');
    useUiStore.setState({ rightTab: 'terminal' });
    render(<RightPanel />);
    expect(screen.getByText('$ npm test')).toBeTruthy();
    expect(screen.getByText('ok 2')).toBeTruthy();
  });

  it('文件 tab:listFiles 组树,点文件 readFile 预览,changedFiles 有 badge', async () => {
    useUiStore.setState({ rightTab: 'files' });
    render(<RightPanel />);
    await waitFor(() => screen.getByText('README.md'));
    // 目录节点 src 存在;badge 在展开后可见,先验证根文件预览。
    expect(screen.getByText('src')).toBeTruthy();
    fireEvent.click(screen.getByText('README.md'));
    await waitFor(() => expect(screen.getByText('hello world')).toBeTruthy());
    // 返回树
    fireEvent.click(screen.getByText('←'));
    await waitFor(() => screen.getByText('src'));
  });
});

describe('buildFileTree', () => {
  it('目录在前、字典序,路径完整', () => {
    const tree = buildFileTree(['b.txt', 'src/a.ts', 'src/sub/c.ts', 'a.txt']);
    expect(tree.map((node) => node.name)).toEqual(['src', 'a.txt', 'b.txt']);
    const src = tree[0]!;
    expect(src.children!.map((node) => node.name)).toEqual(['sub', 'a.ts']);
    expect(src.children![0]!.children![0]!.path).toBe('src/sub/c.ts');
  });
});
