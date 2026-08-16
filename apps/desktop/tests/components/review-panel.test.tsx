// @vitest-environment jsdom
/**
 * Review 面板组件测试:文件列表渲染、展开按需加载 diff、行点击出现评论输入、
 * 提交发出带模板的 run RPC。window.mojocode 以桩替换;reviewStore 直接置态。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLocale } from '../../src/renderer/i18n/index.js';
import { useReviewStore } from '../../src/renderer/state/reviewStore.js';
import { ReviewPanel } from '../../src/renderer/components/ReviewPanel.js';

setLocale('zh-CN');

const rpcMock = vi.fn<(request: unknown) => Promise<unknown>>();

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
    return undefined;
  });
  (window as unknown as { mojocode: unknown }).mojocode = { rpc: rpcMock };
  useReviewStore.setState({
    visible: true,
    unsupported: false,
    status: undefined,
    fileDiffs: {},
    loadingPaths: {},
    expandedPaths: [],
    commentTarget: undefined,
  });
});

describe('ReviewPanel', () => {
  it('可见时拉取 pending 列表并渲染文件行', async () => {
    render(<ReviewPanel />);
    await waitFor(() => {
      expect(screen.getByText('src/a.ts')).toBeTruthy();
      expect(screen.getByText('notes.md')).toBeTruthy();
    });
    // 合计统计(顶栏与文件行各一份)。
    expect(screen.getAllByText('+1').length).toBeGreaterThanOrEqual(1);
  });

  it('点击文件按需加载 diff(带 @@ 头)', async () => {
    const user = userEvent.setup();
    render(<ReviewPanel />);
    await waitFor(() => screen.getByText('src/a.ts'));
    await user.click(screen.getByText('src/a.ts'));
    await waitFor(() => {
      expect(screen.getByText('+new line')).toBeTruthy();
      expect(screen.getByText('-old line')).toBeTruthy();
    });
    expect(rpcMock).toHaveBeenCalledWith({ kind: 'fileDiff', path: 'src/a.ts' });
  });

  it('点击 diff 行 → 输入评论 → 发出 run RPC(display 为 💡 短标签)', async () => {
    const user = userEvent.setup();
    render(<ReviewPanel />);
    await waitFor(() => screen.getByText('src/a.ts'));
    await user.click(screen.getByText('src/a.ts'));
    await waitFor(() => screen.getByText('+new line'));

    await user.click(screen.getByText('+new line'));
    const input = await screen.findByPlaceholderText('评论第 2 行…');
    await user.type(input, '改成空值安全的写法');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith({
        kind: 'run',
        text: '请处理这条代码评审意见:src/a.ts 第 2 行:改成空值安全的写法',
        options: { display: '💬 src/a.ts:2' },
      });
    });
  });

  it('server 过旧(unknown method)降级提示', async () => {
    rpcMock.mockImplementation(async (request: unknown) => {
      const kind = (request as { kind: string }).kind;
      if (kind === 'workspaceStatus') throw new Error('unknown method: workspaceStatus');
      return undefined;
    });
    render(<ReviewPanel />);
    await waitFor(() => {
      expect(screen.getByText('评审面板需要更新的 mojocode server')).toBeTruthy();
    });
  });
});
