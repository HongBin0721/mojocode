import { describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';
import { ReviewPicker } from '../../src/ui/ReviewPicker.js';
import { stubGoal } from '../support/goal.js';
import { EventBus } from '../../src/core/events.js';
import { t } from '../../src/i18n/index.js';
import type { Session } from '../../src/app/bootstrap.js';
import { accentTexts, renderUi } from '../support/otui.js';

/**
 * 覆盖 /review 的 Codex 式预设菜单全链:二级选择器(4 个编号预设)→
 * base/commit 的第二级选择器浮层 → startReview;custom 预填输入框;
 * 直打参数(含回退重发形态)直接开跑。提示词组稿在 server 侧
 * (bootstrap.startReview),UI 只负责菜单流转与失败提示的本地化。
 */
async function setup(
  sessionOverrides: {
    plan?: boolean;
    isRunning?: boolean;
    targets?: { isRepo: boolean; detached?: boolean; currentBranch?: string; branches: { name: string; subject?: string }[] };
    /** 模拟 reviewTargets RPC 传输失败(区别于空列表)。 */
    targetsReject?: boolean;
    commits?: { sha: string; subject: string; date: string }[];
    startReview?: () => Promise<{ ok: boolean; reason?: string; branch?: string; sha?: string }>;
  } = {},
) {
  const bus = new EventBus();
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const targets =
    sessionOverrides.targets ??
    ({
      isRepo: true,
      detached: false,
      currentBranch: 'main',
      branches: [{ name: 'feature', subject: 'first' }],
    } as const);
  const commits = sessionOverrides.commits ?? [
    { sha: 'abc1234', subject: 'second: add b', date: '2 hours ago' },
    { sha: 'def5678', subject: 'first', date: '3 hours ago' },
  ];
  const startReview = vi.fn(
    sessionOverrides.startReview ??
      (async (scopeArg: string, options?: { display?: string }) => {
        // 模拟 server 侧真实行为:罐装提示词只以 display 回显进时间线。
        bus.emit({
          type: 'turn-start',
          userText: 'Review the changes described below and report findings.',
          display: options?.display ?? `/review ${scopeArg}`,
        });
        return { ok: true };
      }),
  );
  const session = {
    root: '/tmp/project',
    config: {
      sandbox: 'workspace-write',
      approval: 'untrusted',
      plan: sessionOverrides.plan ?? false,
      statusBar: [],
    },
    provider,
    agent: {
      isRunning: sessionOverrides.isRunning ?? false,
      isCompacting: false,
      inject: () => false,
      run: vi.fn(async () => {}),
      abort: () => {},
      clear: () => {},
      compact: async () => {},
    },
    bus,
    gate: { setAsker: () => {} },
    todos: { get: () => [], subscribe: () => () => {} },
    goal: stubGoal(vi.fn(async () => {})),
    mcpStatuses: [],
    skills: [],
    skillsChanged: () => () => {},
    store: { id: 'test-session', messages: [] },
    reviewTargets: vi.fn(async () => {
      if (sessionOverrides.targetsReject) throw new Error('server 500');
      return targets;
    }),
    reviewCommits: vi.fn(async () => commits),
    startReview,
    switch: () => provider,
    setMode: () => {},
    refreshEnvironment: async () => {},
    dispose: async () => {},
  } as unknown as Session;

  const ui = await renderUi(() => <App session={session} />, { width: 100, height: 45 });
  const submit = async (text: string) => {
    await ui.type(text);
    await ui.press('return');
    await ui.tick();
  };
  return { bus, startReview, submit, ui };
}

describe('/review 预设菜单', () => {
  it('四个编号预设两行渲染,不含旧范围与裸 value 串', async () => {
    const { startReview, submit, ui } = await setup();

    await submit('/review'); // 回车进二级选择器(异步选项)
    await ui.tick();
    const out = ui.frame();
    expect(out).toContain(t('reviewopt.selectorTitle'));
    expect(out).toContain(`1. ${t('reviewopt.baseTitle')}`);
    expect(out).toContain(`2. ${t('reviewopt.uncommittedTitle')}`);
    expect(out).toContain(`3. ${t('reviewopt.commitTitle')}`);
    expect(out).toContain(`4. ${t('reviewopt.customTitle')}`);
    expect(out).toContain(t('reviewopt.baseDesc'));
    expect(out).not.toContain('last-commit'); // 旧范围已移除
    expect(startReview).not.toHaveBeenCalled();
    await ui.destroy();
  });

  it('预设 1(base)→ 分支选择器 → 回车发起 base feature 一轮', async () => {
    const { startReview, submit, ui } = await setup();

    await submit('/review');
    await ui.tick();
    await ui.press('return'); // 选预设 1:提交 /review base
    await ui.tick();
    await ui.tick(); // reviewTargets 落地后开出分支选择器
    const out = ui.frame();
    expect(out).toContain(t('reviewpick.branchTitle'));
    expect(out).toContain('feature');
    expect(out).toContain('first'); // 分支行带最新提交标题
    await ui.press('return'); // 选中 feature
    await ui.tick();

    expect(startReview).toHaveBeenCalledWith('base feature', { display: '/review base feature' });
    // 时间线只见命令,不见提示词正文。
    const final = ui.frame();
    expect(final).toContain('/review base feature');
    expect(final).not.toContain('Review the changes described below');
    await ui.destroy();
  });

  it('预设 2(uncommitted)直接发起;预设 3(commit)→ 提交选择器', async () => {
    const direct = await setup();
    await direct.submit('/review');
    await direct.ui.tick();
    await direct.ui.press('down'); // 光标到预设 2
    await direct.ui.press('return');
    await direct.ui.tick();
    expect(direct.startReview).toHaveBeenCalledWith('uncommitted', {
      display: '/review uncommitted',
    });
    await direct.ui.destroy();

    const pick = await setup();
    await pick.submit('/review');
    await pick.ui.tick();
    await pick.ui.press('down');
    await pick.ui.press('down'); // 预设 3:commit
    await pick.ui.press('return');
    await pick.ui.tick();
    await pick.ui.tick();
    const out = pick.ui.frame();
    expect(out).toContain(t('reviewpick.commitTitle'));
    expect(out).toContain('abc1234');
    expect(out).toContain('second: add b');
    await pick.ui.press('return');
    await pick.ui.tick();
    expect(pick.startReview).toHaveBeenCalledWith('commit abc1234', {
      display: '/review commit abc1234',
    });
    await pick.ui.destroy();
  });

  it('预设 4(custom)预填输入框,补文本提交后按 custom 开跑', async () => {
    const { startReview, submit, ui } = await setup();

    await submit('/review');
    await ui.tick();
    await ui.press('down');
    await ui.press('down');
    await ui.press('down'); // 预设 4:custom
    await ui.press('return');
    await ui.tick();
    // 输入框回填半成品(尾随空格保持命令菜单关闭)。
    expect(ui.frame()).toContain('/review custom ');
    await ui.type('关注并发');
    await ui.press('return');
    await ui.tick();

    expect(startReview).toHaveBeenCalledWith('custom 关注并发', {
      display: '/review custom 关注并发',
    });
    await ui.destroy();
  });
});

describe('/review 直打与边界', () => {
  it('直打 base <分支> 不经开选择器直接开跑', async () => {
    const { startReview, submit, ui } = await setup();

    await submit('/review base feature');

    expect(startReview).toHaveBeenCalledWith('base feature', { display: '/review base feature' });
    expect(ui.frame()).not.toContain(t('reviewpick.branchTitle'));
    await ui.destroy();
  });

  it('直打 commit <sha> 与 custom <焦点> 直接开跑', async () => {
    const a = await setup();
    await a.submit('/review commit abc1234');
    expect(a.startReview).toHaveBeenCalledWith('commit abc1234', {
      display: '/review commit abc1234',
    });
    await a.ui.destroy();

    const b = await setup();
    await b.submit('/review custom 重点看错误处理');
    expect(b.startReview).toHaveBeenCalledWith('custom 重点看错误处理', {
      display: '/review custom 重点看错误处理',
    });
    await b.ui.destroy();
  });

  it('裸 /review 给用法提示;非 git 仓库给出 no-repo', async () => {
    // 带尾随空格:无空格的 `/review` 回车会被命令菜单劫持去开二级选择器。
    const { startReview, submit, ui } = await setup();
    await submit('/review ');
    expect(startReview).not.toHaveBeenCalled();
    expect(ui.frame()).toContain(t('notice.reviewUsage'));
    await ui.destroy();

    const noRepo = await setup({ targets: { isRepo: false, detached: false, branches: [] } });
    await noRepo.submit('/review');
    await noRepo.ui.tick();
    await noRepo.ui.tick();
    expect(noRepo.startReview).not.toHaveBeenCalled();
    expect(noRepo.ui.frame()).toContain(t('notice.reviewNoRepo'));
    await noRepo.ui.destroy();
  });

  it('last-commit 已移除:给用法提示', async () => {
    const { startReview, submit, ui } = await setup();

    await submit('/review last-commit');

    expect(startReview).not.toHaveBeenCalled();
    expect(ui.frame()).toContain(t('notice.reviewUsage'));
    await ui.destroy();
  });

  it('第二级选择器 esc 退回预设层,光标还原到刚才的预设', async () => {
    const { startReview, submit, ui } = await setup();

    await submit('/review commit'); // 直接开提交选择器
    await ui.tick();
    await ui.tick();
    expect(ui.frame()).toContain(t('reviewpick.commitTitle'));

    await ui.press('escape'); // esc = 返回上一级
    await ui.tick();
    await ui.tick(); // 预设选项异步落地
    const out = ui.frame();
    expect(out).toContain(t('reviewopt.selectorTitle'));
    expect(out).toContain(`3. ${t('reviewopt.commitTitle')}`);
    expect(out).not.toContain(t('reviewpick.commitTitle')); // 第二级已关

    // 光标还原在预设 3(commit):直接回车应重开提交选择器而非分支选择器。
    await ui.press('return');
    await ui.tick();
    await ui.tick();
    expect(ui.frame()).toContain(t('reviewpick.commitTitle'));
    expect(startReview).not.toHaveBeenCalled();
    await ui.destroy();
  });

  it('没有其他分支 / 没有提交时给出对应提示,不开选择器', async () => {
    const noBranch = await setup({ targets: { isRepo: true, detached: false, currentBranch: 'main', branches: [] } });
    await noBranch.submit('/review base');
    expect(noBranch.startReview).not.toHaveBeenCalled();
    expect(noBranch.ui.frame()).toContain(t('notice.reviewNoBranches'));
    await noBranch.ui.destroy();

    const noCommits = await setup({ commits: [] });
    await noCommits.submit('/review commit');
    expect(noCommits.startReview).not.toHaveBeenCalled();
    expect(noCommits.ui.frame()).toContain(t('notice.reviewNoCommits'));
    await noCommits.ui.destroy();
  });

  it('plan 模式在开选择器之前拦下(裸命令同样拦)', async () => {
    const { startReview, submit, ui } = await setup({ plan: true });

    await submit('/review base');

    expect(startReview).not.toHaveBeenCalled();
    expect(ui.frame()).toContain(t('notice.reviewPlanMode'));
    expect(ui.frame()).not.toContain(t('reviewpick.branchTitle'));
    await ui.destroy();

    const bare = await setup({ plan: true });
    await bare.submit('/review ');
    expect(bare.ui.frame()).toContain(t('notice.reviewPlanMode'));
    await bare.ui.destroy();
  });

  it('git 收集窗口期内第二个 /review 被 busy 拦住,不注入第一个流', async () => {
    // 本地路径 startReview 先跑 collectReviewSummary 再 agent.run,窗口期内
    // isRunning 仍为 false——回归:曾经 submitPending 不占,第二个 /review
    // 撞上 loop.ts 的防重入兜底退化成轮中注入。
    const pending = await setup({
      startReview: () => new Promise(() => {}) as never,
    });
    await pending.submit('/review uncommitted');
    expect(pending.startReview).toHaveBeenCalledTimes(1);

    await pending.submit('/review uncommitted');
    expect(pending.startReview).toHaveBeenCalledTimes(1); // 没有第二个调用
    expect(pending.ui.frame()).toContain(t('notice.busyCommand', { name: 'review' }));
    await pending.ui.destroy();
  });

  it('base/commit 在非仓库里报 no-repo,不误报成"没有可选项"', async () => {
    const noRepoBase = await setup({ targets: { isRepo: false, detached: false, branches: [] } });
    await noRepoBase.submit('/review base');
    expect(noRepoBase.ui.frame()).toContain(t('notice.reviewNoRepo'));
    expect(noRepoBase.ui.frame()).not.toContain(t('notice.reviewNoBranches'));
    await noRepoBase.ui.destroy();

    const noRepoCommit = await setup({
      targets: { isRepo: false, detached: false, branches: [] },
      commits: [],
    });
    await noRepoCommit.submit('/review commit');
    expect(noRepoCommit.ui.frame()).toContain(t('notice.reviewNoRepo'));
    expect(noRepoCommit.ui.frame()).not.toContain(t('notice.reviewNoCommits'));
    await noRepoCommit.ui.destroy();
  });

  it('reviewTargets RPC 拒绝如实报 reviewFailed,不吞成空表', async () => {
    const bad = await setup({ targetsReject: true });
    await bad.submit('/review base');
    expect(bad.ui.frame()).toContain(t('notice.reviewFailed', { message: 'server 500' }));
    expect(bad.ui.frame()).not.toContain(t('notice.reviewNoBranches'));
    await bad.ui.destroy();
  });

  it('预设层 RPC 失败经空表回退后也如实报 reviewFailed,不误报用法', async () => {
    // 链路:选项拉取失败 → 选择器拿到空表 → Input 回退裸提交 /review →
    // !arg 分支再探一次仍失败 → reviewFailed(回归:曾退化成用法提示)。
    const bad = await setup({ targetsReject: true });
    await bad.ui.type('/review');
    await bad.ui.press('return');
    await bad.ui.tick();
    await bad.ui.tick();
    expect(bad.ui.frame()).toContain(t('notice.reviewFailed', { message: 'server 500' }));
    expect(bad.ui.frame()).not.toContain(t('notice.reviewUsage'));
    await bad.ui.destroy();
  });

  it('git 收集窗口内 esc 不重开 busy 门(回归:曾清掉 submitPending)', async () => {
    const pending = await setup({
      startReview: () => new Promise(() => {}) as never,
    });
    await pending.submit('/review uncommitted');
    expect(pending.startReview).toHaveBeenCalledTimes(1);

    await pending.ui.press('escape'); // 收集窗口内:esc 不作废、不清标志
    await pending.ui.tick();
    await pending.submit('/review uncommitted');

    expect(pending.startReview).toHaveBeenCalledTimes(1);
    expect(pending.ui.frame()).toContain(t('notice.busyCommand', { name: 'review' }));
    await pending.ui.destroy();
  });

  it('运行中被 busy 拦截', async () => {
    const { startReview, submit, ui } = await setup({ isRunning: true });

    await submit('/review uncommitted');

    expect(startReview).not.toHaveBeenCalled();
    expect(ui.frame()).toContain(t('notice.busyCommand', { name: 'review' }));
    await ui.destroy();
  });

  it('失败 reason 映射本地化提示:unknown-commit 带 sha、clean-tree 是 info', async () => {
    const unknown = await setup({
      startReview: async () => ({ ok: false, reason: 'unknown-commit', sha: 'deadbeef' }),
    });
    await unknown.submit('/review commit deadbeef');
    expect(unknown.ui.frame()).toContain(t('notice.reviewUnknownCommit', { sha: 'deadbeef' }));
    await unknown.ui.destroy();

    const clean = await setup({ startReview: async () => ({ ok: false, reason: 'clean-tree' }) });
    await clean.submit('/review uncommitted');
    expect(clean.ui.frame()).toContain(t('notice.reviewCleanTree'));
    await clean.ui.destroy();
  });

  it('RPC 拒绝映射 reviewFailed,不产生未捕获的 rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on('unhandledRejection', onRejection);

    const bad = await setup({
      startReview: async () => {
        throw new Error('server 500');
      },
    });
    await bad.submit('/review uncommitted');
    await bad.ui.tick();

    process.off('unhandledRejection', onRejection);
    expect(rejections).toEqual([]);
    expect(bad.ui.frame()).toContain(t('notice.reviewFailed', { message: 'server 500' }));
    await bad.ui.destroy();
  });
});

describe('ReviewPicker 选中高亮', () => {
  // 回归:head 曾包在 color=undefined 的嵌套 <Text> 里,span 不继承外层
  // accent(fg 落回默认白),选中行与未选行几乎无差别。
  const rows = [
    { value: 'abc1234', head: 'abc1234', detail: 'fix: 修复 · 2 hours ago' },
    { value: 'def5678', head: 'def5678', detail: 'feat: 功能 · 3 hours ago' },
  ];

  it('光标行整行 accent(sha 与说明一起),下移后高亮跟随,回车选中', async () => {
    const picked: string[] = [];
    const ui = await renderUi(
      () => (
        <ReviewPicker title="选择要审查的提交" rows={rows} onPick={(v) => picked.push(v)} onCancel={() => {}} />
      ),
      { width: 80, height: 16 },
    );
    await ui.tick();
    expect(accentTexts(ui, /abc1234/)).toEqual(['abc1234 fix: 修复 · 2 hours ago']);
    await ui.press('down');
    expect(accentTexts(ui, /def5678/)).toEqual(['def5678 feat: 功能 · 3 hours ago']);
    expect(accentTexts(ui, /abc1234/)).toEqual([]); // 上一行不再高亮
    await ui.press('return');
    expect(picked).toEqual(['def5678']);
    await ui.destroy();
  });
});
