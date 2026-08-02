import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import { EventBus } from '../src/core/events.js';
import { t } from '../src/i18n/index.js';
import { presetById, type Permissions } from '../src/config/schema.js';
import type { Session } from '../src/app/bootstrap.js';

// 等待 React 把 bus 事件触发的 setState 刷进帧。
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

/**
 * 覆盖 /plan:裸命令只切模式,`/plan <任务>` 顺带以任务原文发起一轮。
 * 任务原文不套 display——用户写的就是他的意图本身。
 */
function setup(
  agentOverrides: Record<string, unknown> = {},
  options: { permissions?: Permissions; plan?: boolean } = {},
) {
  const bus = new EventBus();
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const run = vi.fn(async () => {});
  const perms = options.permissions ?? presetById('ask');
  const config = {
    sandbox: perms.sandbox,
    approval: perms.approval,
    plan: options.plan ?? false,
    statusBar: ['mode'],
  };
  const setPermissions = vi.fn((next: Permissions) => {
    config.sandbox = next.sandbox;
    config.approval = next.approval;
    config.plan = false;
  });
  const setPlan = vi.fn((active: boolean) => {
    config.plan = active;
  });
  const session = {
    root: '/tmp/project',
    config,
    provider,
    agent: {
      isRunning: false,
      isCompacting: false,
      inject: () => false,
      run,
      abort: () => {},
      clear: () => {},
      compact: async () => {},
      ...agentOverrides,
    },
    bus,
    gate: { setAsker: () => {} },
    todos: { get: () => [], subscribe: () => () => {} },
    mcpStatuses: [],
    store: { id: 'test-session', messages: [] },
    switch: () => provider,
    setPermissions,
    setPlan,
    refreshEnvironment: async () => {},
    dispose: async () => {},
  } as unknown as Session;

  const view = render(<App session={session} />);
  const submit = async (text: string) => {
    view.stdin.write(text);
    await tick();
    view.stdin.write('\r');
    await tick();
  };
  return { bus, run, setPermissions, setPlan, submit, ...view };
}

describe('/plan 命令', () => {
  it('裸 /plan 只切模式,不发起一轮', async () => {
    const { submit, run, setPlan, frames, unmount } = setup();
    await tick();

    await submit('/plan');

    expect(setPlan).toHaveBeenCalledWith(true);
    expect(run).not.toHaveBeenCalled();
    expect(frames.join('\n')).toContain(t('notice.planEntered'));
    unmount();
  });

  // 不套 display:实时时间线与 /resume 回放因此天然一致,回退重发也能重跑。
  it('/plan <任务> 切模式后以任务原文发起一轮', async () => {
    const { submit, run, setPlan, unmount } = setup();
    await tick();

    await submit('/plan 给 list() 加索引缓存');

    expect(setPlan).toHaveBeenCalledWith(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('给 list() 加索引缓存');
    unmount();
  });

  // BUSY_BLOCKED_COMMANDS 按命令名判断,表达不了"只有带参数时才拦"。
  it('运行中带任务的 /plan 被拦,裸 /plan 仍可用', async () => {
    const { submit, run, setPlan, frames, unmount } = setup({ isRunning: true });
    await tick();

    await submit('/plan 改点东西');
    expect(run).not.toHaveBeenCalled();
    expect(frames.join('\n')).toContain(t('notice.busyCommand', { name: 'plan' }));

    await submit('/plan');
    expect(setPlan).toHaveBeenCalledWith(true);
    unmount();
  });

  it('已在 plan 模式时再次 /plan 不重复切模式', async () => {
    const { submit, setPlan, run, unmount } = setup({}, { plan: true });
    await tick();

    await submit('/plan 继续这个任务');

    expect(setPlan).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('继续这个任务');
    unmount();
  });

  // read-only+never 进来的话批准后会提升到 ask,提前说明,免得用户以为设置被吞了。
  it('从 read-only+never 进入时说明批准后会切到 ask', async () => {
    const { submit, frames, unmount } = setup(
      {},
      { permissions: { sandbox: 'read-only', approval: 'never' } },
    );
    await tick();

    await submit('/plan');

    expect(frames.join('\n')).toContain(t('notice.planReturnFromReadonly'));
    unmount();
  });

  it('run() 失败只提示,不产生未捕获的 rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on('unhandledRejection', onRejection);

    const { submit, frames, unmount } = setup({
      run: vi.fn(async () => {
        throw new Error('模型炸了');
      }),
    });
    await tick();

    await submit('/plan 做点什么');
    await tick();

    process.off('unhandledRejection', onRejection);
    expect(rejections).toHaveLength(0);
    expect(frames.join('\n')).toContain('模型炸了');
    unmount();
  });
});

describe('mode-change 事件', () => {
  // 方案获批后模式由工具侧切换,不订阅的话状态栏会一直停在 plan。
  it('驱动状态栏更新,无需命令侧同步', async () => {
    const { bus, frames, unmount } = setup({}, { plan: true });
    await tick();

    bus.emit({ type: 'permission-change', permissions: presetById('auto'), plan: false });
    await tick();

    expect(frames[frames.length - 1]).toContain('auto');
    unmount();
  });
});

describe('方案审批确认框', () => {
  it('kind=plan 渲染方案正文与两个计划专属选项', async () => {
    const { bus, frames, unmount } = setup();
    await tick();

    bus.emit({
      type: 'permission-request',
      request: {
        id: 'p1',
        kind: 'plan',
        toolName: 'exit_plan',
        title: t('perm.planTitle'),
        detail: '# 缓存方案\n\n1. 改 store.ts',
        risk: 'write',
      },
    });
    await tick();

    const out = frames[frames.length - 1] ?? '';
    expect(out).toContain(t('perm.planTitle'));
    expect(out).toContain(t('perm.planApprove'));
    expect(out).toContain(t('perm.planKeepPlanning'));
    expect(out).toContain('缓存方案');
    // 工具授权那套文案不该出现。
    expect(out).not.toContain(t('perm.alwaysPersist'));
    unmount();
  });
});

describe('计划模式下没提交方案的兜底提示', () => {
  // 提示词要求模型必须走 exit_plan,但那只是提示词——它仍可能调研完直接
  // 作答收尾。门禁保证这一轮没改动任何东西,但"我用了 /plan 它却没问我"
  // 必须看得见。
  it('plan 模式下一轮结束时没调过 exit_plan 就出声', async () => {
    const { bus, frames, unmount } = setup({}, { plan: true });
    await tick();

    bus.emit({ type: 'turn-start', userText: '查询项目信息' });
    await tick();
    bus.emit({
      type: 'turn-end',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cumulativeTotalTokens: 2, contextWindow: 100 },
      finishReason: 'stop',
    });
    await tick();

    expect(frames.join('\n')).toContain('without submitting a plan');
    unmount();
  });

  it('调过 exit_plan 就不再提示', async () => {
    const { bus, frames, unmount } = setup({}, { plan: true });
    await tick();

    bus.emit({ type: 'turn-start', userText: '加个函数' });
    await tick();
    bus.emit({ type: 'tool-start', callId: 'c1', toolName: 'exit_plan', input: { plan: '# 方案' } });
    await tick();
    bus.emit({
      type: 'turn-end',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cumulativeTotalTokens: 2, contextWindow: 100 },
      finishReason: 'stop',
    });
    await tick();

    expect(frames.join('\n')).not.toContain('without submitting a plan');
    unmount();
  });

  it('非计划模式下不出现这条提示', async () => {
    const { bus, frames, unmount } = setup({}, {});
    await tick();

    bus.emit({ type: 'turn-start', userText: '随便做点什么' });
    await tick();
    bus.emit({
      type: 'turn-end',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cumulativeTotalTokens: 2, contextWindow: 100 },
      finishReason: 'stop',
    });
    await tick();

    expect(frames.join('\n')).not.toContain('without submitting a plan');
    unmount();
  });
});

// ink 把 shift+tab(CSI Z / backtab)报成 key.tab + key.shift。
const SHIFT_TAB = '\x1b[Z';

describe('shift+tab 循环切权限模式', () => {
  it('ask → auto → plan → ask', async () => {
    const { stdin, setPermissions, setPlan, frames, unmount } = setup();
    await tick();

    stdin.write(SHIFT_TAB);
    await tick();
    expect(setPermissions).toHaveBeenLastCalledWith(presetById('auto'));

    stdin.write(SHIFT_TAB);
    await tick();
    expect(setPlan).toHaveBeenLastCalledWith(true);

    stdin.write(SHIFT_TAB);
    await tick();
    expect(setPermissions).toHaveBeenLastCalledWith(presetById('ask'));

    // 状态栏要有回显,否则按下去毫无反馈。
    expect(frames.join('\n')).toContain('permission mode: plan');
    unmount();
  });

  // full-access 绕过硬拒名单,绝不能离一个快捷键只有一步之遥。
  it('从 full-access 按下落到 plan,而不是留在原地或滑向更宽松', async () => {
    const { stdin, setPlan, unmount } = setup({}, { permissions: presetById('full-access') });
    await tick();

    stdin.write(SHIFT_TAB);
    await tick();

    expect(setPlan).toHaveBeenLastCalledWith(true);
    unmount();
  });

  it('从 read-only 按下落到 plan,同样写不了东西', async () => {
    const { stdin, setPlan, unmount } = setup({}, { permissions: presetById('read-only') });
    await tick();

    stdin.write(SHIFT_TAB);
    await tick();

    expect(setPlan).toHaveBeenLastCalledWith(true);
    unmount();
  });

  // 在"要不要放行这一次"的中途改掉规则本身,是最容易出事的地方。
  it('授权确认框开着时不响应', async () => {
    const { bus, stdin, setPermissions, setPlan, unmount } = setup();
    await tick();

    bus.emit({
      type: 'permission-request',
      request: { id: 'w1', toolName: 'write', title: 'write a.ts', risk: 'write' },
    });
    await tick();

    stdin.write(SHIFT_TAB);
    await tick();

    expect(setPermissions).not.toHaveBeenCalled();
    expect(setPlan).not.toHaveBeenCalled();
    unmount();
  });
});

describe('轮中途切进计划模式', () => {
  // shift+tab 不看 running,轮中途切进来的那一轮用户压根没让它规划,
  // 收尾时追问方案只会莫名其妙。判据是"本轮开始时"是否已在计划模式。
  it('不追问方案:该轮开始时并不在计划模式', async () => {
    const { bus, stdin, frames, unmount } = setup();
    await tick();

    bus.emit({ type: 'turn-start', userText: '随手改点东西' });
    await tick();
    stdin.write(SHIFT_TAB); // ask → auto
    await tick();
    stdin.write(SHIFT_TAB); // auto → plan,轮还在跑
    await tick();
    bus.emit({
      type: 'turn-end',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cumulativeTotalTokens: 2, contextWindow: 100 },
      finishReason: 'stop',
    });
    await tick();

    expect(frames.join('\n')).not.toContain('without submitting a plan');
    unmount();
  });

  it('开轮时就在计划模式的,照常追问', async () => {
    const { bus, frames, unmount } = setup({}, { plan: true });
    await tick();

    bus.emit({ type: 'turn-start', userText: '查点东西' });
    await tick();
    bus.emit({
      type: 'turn-end',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cumulativeTotalTokens: 2, contextWindow: 100 },
      finishReason: 'stop',
    });
    await tick();

    expect(frames.join('\n')).toContain('without submitting a plan');
    unmount();
  });
});
