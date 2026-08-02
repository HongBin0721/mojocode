import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import { EventBus } from '../src/core/events.js';
import { INIT_PROMPT } from '../src/agent/init.js';
import { t } from '../src/i18n/index.js';
import type { Session } from '../src/app/bootstrap.js';

// 等待 React 把 bus 事件触发的 setState 刷进帧。
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

/**
 * 覆盖 /init 命令:它是唯一发起完整 agent 轮的斜杠命令——完整指令喂给
 * 模型,时间线只回显 `/init`(turn-start 的 display),轮后刷新环境信息。
 */
function setup(
  agentOverrides: Record<string, unknown> = {},
  sessionOverrides: {
    sandbox?: string;
    approval?: string;
    plan?: boolean;
    refreshEnvironment?: () => Promise<void>;
  } = {},
) {
  const bus = new EventBus();
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const run = vi.fn(async () => {});
  const refreshEnvironment = vi.fn(sessionOverrides.refreshEnvironment ?? (async () => {}));
  const session = {
    root: '/tmp/project',
    config: {
      sandbox: sessionOverrides.sandbox ?? 'workspace-write',
      approval: sessionOverrides.approval ?? 'untrusted',
      plan: sessionOverrides.plan ?? false,
      statusBar: [],
    },
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
    setMode: () => {},
    refreshEnvironment,
    dispose: async () => {},
  } as unknown as Session;

  const view = render(<App session={session} />);
  return { bus, run, refreshEnvironment, ...view };
}

describe('/init 命令', () => {
  it('提交 /init:完整指令进 run,display 为 /init,轮后刷新环境', async () => {
    const { stdin, run, refreshEnvironment, frames, unmount } = setup();
    await tick();

    stdin.write('/init');
    await tick();
    stdin.write('\r');
    await tick();

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(INIT_PROMPT, { display: '/init' });
    expect(refreshEnvironment).toHaveBeenCalledTimes(1);
    // 指令正文不允许出现在时间线(只回显 /init)。
    expect(frames.join('\n')).not.toContain('agent audience');
    unmount();
  });

  it('turn-start 带 display 时时间线显示 display 而非完整指令', async () => {
    const { bus, frames, unmount } = setup();
    await tick();

    bus.emit({ type: 'turn-start', userText: '很长很长的 init 指令正文', display: '/init' });
    await tick();

    const out = frames.join('\n');
    expect(out).toContain('/init');
    expect(out).not.toContain('很长很长的 init 指令正文');
    unmount();
  });

  it('不带 display 的 turn-start 仍回显 userText(回归)', async () => {
    const { bus, frames, unmount } = setup();
    await tick();

    bus.emit({ type: 'turn-start', userText: '普通的用户消息' });
    await tick();

    expect(frames.join('\n')).toContain('普通的用户消息');
    unmount();
  });

  // 提示语按框宽折行,断言取不会被折断的片段,而不是整条消息。
  it('readonly 模式提前拦下,不白烧一轮', async () => {
    const { stdin, run, frames, unmount } = setup({}, { sandbox: 'read-only', approval: 'never' });
    await tick();

    stdin.write('/init');
    await tick();
    stdin.write('\r');
    await tick();

    expect(run).not.toHaveBeenCalled();
    expect(frames.join('\n')).toContain('/init needs to write AGENTS.md');
    expect(frames.join('\n')).toContain('refuses every write');
    unmount();
  });

  // plan 与 readonly 一样硬拒写入,这一轮同样注定写不出 AGENTS.md。
  it('plan 模式同样提前拦下', async () => {
    const { stdin, run, frames, unmount } = setup({}, { plan: true });
    await tick();

    stdin.write('/init');
    await tick();
    stdin.write('\r');
    await tick();

    expect(run).not.toHaveBeenCalled();
    expect(frames.join('\n')).toContain('refuses every write');
    unmount();
  });

  it('refreshEnvironment 失败只提示,不产生未捕获的 rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on('unhandledRejection', onRejection);

    const { stdin, frames, unmount } = setup(
      {},
      {
        refreshEnvironment: async () => {
          throw new Error('环境读取炸了');
        },
      },
    );
    await tick();

    stdin.write('/init');
    await tick();
    stdin.write('\r');
    await tick();
    await tick();

    process.off('unhandledRejection', onRejection);
    expect(rejections).toEqual([]);
    expect(frames.join('\n')).toContain('环境读取炸了');
    unmount();
  });

  it('agent 运行中提交 /init 被拒,不会降级为引导注入', async () => {
    const { stdin, run, frames, unmount } = setup({ isRunning: true });
    await tick();

    stdin.write('/init');
    await tick();
    stdin.write('\r');
    await tick();

    expect(run).not.toHaveBeenCalled();
    expect(frames.join('\n')).toContain(t('notice.busyCommand', { name: 'init' }));
    unmount();
  });
});
