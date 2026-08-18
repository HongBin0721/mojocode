/**
 * Review store 的刷新时序与工作区切换收尾:
 *  - 并发 refresh 合并成一次 git 扫描(4 个触发点彼此不知情);
 *  - 扫描**开跑之后**到达的请求要补跑一次——它要的是那之后的工作区状态
 *    (focus 的扫描先跑、turn-end 的写入随后落盘),复用旧结果会漏掉本轮
 *    改过的文件;
 *  - reset() 丢掉属于旧 root 的全部缓存(fileDiffs 按相对路径存,新工作区
 *    的同名文件会命中旧 diff)。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useReviewStore } from '../src/renderer/state/reviewStore.js';

/** 受控的 workspaceStatus:每次调用返回一个可手动兑现的 promise。 */
function mockRpc() {
  const pending: Array<(value: unknown) => void> = [];
  const rpc = vi.fn((request: { kind: string }) => {
    if (request.kind !== 'workspaceStatus') return Promise.resolve(undefined);
    return new Promise((resolve) => pending.push(resolve));
  });
  (globalThis as { mojocode?: unknown }).mojocode = { rpc };
  return { rpc, pending };
}

const status = (branch: string) => ({ ok: true, branch, entries: [], additions: 0, deletions: 0, truncated: false });

describe('reviewStore.refresh 的合并与补跑', () => {
  beforeEach(() => {
    useReviewStore.setState({ status: undefined, unsupported: false, fileDiffs: {}, selectedPath: undefined, approval: 'idle' });
  });

  it('扫描期间的并发调用合并成一次 RPC,并补跑一次拿到之后的状态', async () => {
    const { rpc, pending } = mockRpc();
    const store = useReviewStore.getState();

    const first = store.refresh(); // t=0 起扫
    void store.refresh(); // 扫描中到达 → 合并,但要补跑
    void store.refresh(); // 再来一次仍只补跑一次
    expect(rpc).toHaveBeenCalledTimes(1);

    pending[0]!(status('old'));
    await first;
    // 补跑已发出(第二次 RPC),旧结果先落地
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(useReviewStore.getState().status?.branch).toBe('old');

    pending[1]!(status('new'));
    await Promise.resolve();
    await Promise.resolve();
    expect(useReviewStore.getState().status?.branch).toBe('new');
    // 补跑落定后不再无限续跑
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('串行调用各发一次 RPC(合并只针对进行中的扫描)', async () => {
    const { rpc, pending } = mockRpc();
    const store = useReviewStore.getState();
    const first = store.refresh();
    pending[0]!(status('a'));
    await first;
    const second = store.refresh();
    pending[1]!(status('b'));
    await second;
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('reset 丢掉旧工作区的状态与 diff 缓存', () => {
    useReviewStore.setState({
      status: status('main') as never,
      unsupported: true,
      fileDiffs: { 'src/index.ts': { ok: true, path: 'src/index.ts', truncated: false } },
      loadingPaths: { 'src/index.ts': true },
      selectedPath: 'src/index.ts',
      commentTarget: { path: 'src/index.ts', line: 3, side: 'new' },
      approval: 'committed',
      lastCommit: { branch: 'main' },
    });
    useReviewStore.getState().reset();
    const after = useReviewStore.getState();
    expect(after.status).toBeUndefined();
    expect(after.unsupported).toBe(false);
    expect(after.fileDiffs).toEqual({});
    expect(after.loadingPaths).toEqual({});
    expect(after.selectedPath).toBeUndefined();
    expect(after.commentTarget).toBeUndefined();
    expect(after.approval).toBe('idle');
    expect(after.lastCommit).toBeUndefined();
  });

  it('批准流:approve 成功进入 committed;新 pending 出现时回落 idle', async () => {
    const pendingResolves: Array<(value: unknown) => void> = [];
    const rpc = vi.fn((request: { kind: string }) => {
      if (request.kind === 'commitAll') return Promise.resolve({ ok: true, sha: 'a'.repeat(40) });
      if (request.kind === 'workspaceStatus') {
        return new Promise((resolve) => pendingResolves.push(resolve));
      }
      return Promise.resolve(undefined);
    });
    (globalThis as { mojocode?: unknown }).mojocode = { rpc };
    useReviewStore.setState({
      status: { ok: true, branch: 'main', entries: [], additions: 0, deletions: 0, truncated: false },
    });

    const approving = useReviewStore.getState().approve('msg');
    // commitAll 是异步的:等 refresh 的 workspaceStatus RPC 真正发出再兑现。
    while (pendingResolves.length === 0) await Promise.resolve();
    pendingResolves[0]!(status('main')); // 提交后的干净树
    await approving;
    expect(useReviewStore.getState().approval).toBe('committed');
    expect(useReviewStore.getState().lastCommit?.branch).toBe('main');

    // 不变量:又出现新 pending 时 committed 必须回落——横幅不能盖住新变更。
    const refreshing = useReviewStore.getState().refresh();
    pendingResolves[1]!({
      ok: true,
      branch: 'main',
      entries: [{ path: 'a.ts', change: 'modified', staged: false }],
      additions: 1,
      deletions: 0,
      truncated: false,
    });
    await refreshing;
    expect(useReviewStore.getState().approval).toBe('idle');
  });

  it('approve 失败:回 idle 并留 approvalError', async () => {
    const rpc = vi.fn((request: { kind: string }) => {
      if (request.kind === 'commitAll') {
        return Promise.resolve({ ok: false, reason: 'git-error', detail: 'boom' });
      }
      return Promise.resolve(status('main'));
    });
    (globalThis as { mojocode?: unknown }).mojocode = { rpc };
    await useReviewStore.getState().approve('msg');
    expect(useReviewStore.getState().approval).toBe('idle');
    expect(useReviewStore.getState().approvalError).toBe('boom');
  });
});
