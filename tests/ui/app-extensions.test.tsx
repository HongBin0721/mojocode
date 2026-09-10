import { describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';
import { EventBus } from '../../src/core/events.js';
import { t } from '../../src/i18n/index.js';
import { WIDTH_SAFETY } from '../../src/ui/theme.js';
import { ExtensionStatusLine } from '../../src/ui/ExtensionStatusLine.js';
import type { Session } from '../../src/app/bootstrap.js';
import type { ExtensionCommandInfo, ExtensionStatusEntry } from '../../src/core/extension.js';
import { renderUi } from '../support/otui.js';
import { stubExtensions } from '../support/extensions.js';

/**
 * 扩展在 TUI 里的接入面:命令表进 `/` 菜单并派发到 runCommand、状态行贴在
 * 输入框上方、链条的开关灯(turn-end 不熄、run-end 才熄)。扩展本体
 * (/goal 的循环)在 goal-extension.test.ts 里测,这里不关心它做什么。
 */
async function setup(options?: {
  isRunning?: boolean;
  commands?: ExtensionCommandInfo[];
  status?: ExtensionStatusEntry[];
}) {
  const bus = new EventBus();
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const run = vi.fn(async () => {});
  const runCommand = vi.fn(async () => {});
  const abort = vi.fn();
  const listeners = new Set<() => void>();
  const status: ExtensionStatusEntry[] = options?.status ?? [];
  const session = {
    root: '/tmp/project',
    config: {
      sandbox: 'workspace-write',
      approval: 'untrusted',
      plan: false,
      statusBar: ['mode'],
      permissions: { denyPath: [] },
    },
    provider,
    agent: {
      isRunning: options?.isRunning ?? false,
      isCompacting: false,
      history: [],
      inject: () => false,
      run,
      abort,
      clear: () => {},
      compact: async () => {},
    },
    bus,
    skills: [],
    skillsChanged: () => () => {},
    // 扩展面的其余成员用共享的桩:App 挂载时会读它们,少一个就运行期炸。
    ...stubExtensions(),
    extensionCommands: options?.commands ?? [
      { name: 'goal', description: 'Keep working', argumentHint: '<condition> | clear' },
    ],
    get extensionStatus() {
      return [...status];
    },
    extensionState: {},
    extensionsChanged: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    runCommand,
    store: { id: 'test-session', messages: [] },
    switch: () => provider,
    setPermissions: () => {},
    setPlan: () => {},
    refreshEnvironment: async () => {},
    dispose: async () => {},
  } as unknown as Session;

  const ui = await renderUi(() => <App session={session} />, { width: 100, height: 45 });
  const submit = async (text: string) => {
    await ui.type(text);
    await ui.press('return');
    await ui.tick();
  };
  /** 模拟会话进程推来新的状态行:改镜像数组,再通知订阅者。 */
  const setStatus = async (entries: ExtensionStatusEntry[]) => {
    status.splice(0, status.length, ...entries);
    for (const listener of listeners) listener();
    await ui.tick();
  };
  return { bus, run, runCommand, abort, submit, setStatus, ui };
}

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cumulativeTotalTokens: 2, contextWindow: 1000 };

describe('扩展命令', () => {
  it('/goal <条件> 派发到 runCommand,带原文;不在这里发起轮次', async () => {
    const { submit, runCommand, run, ui } = await setup();
    await submit('/goal 让 npm test 全绿');
    expect(runCommand).toHaveBeenCalledWith('goal', '让 npm test 全绿');
    expect(run).not.toHaveBeenCalled();
    await ui.destroy();
  });

  it('运行中照样派发:忙不忙由扩展自己按参数判(/goal clear 正是这时候用的)', async () => {
    const { submit, runCommand, ui } = await setup({ isRunning: true });
    await submit('/goal clear');
    expect(runCommand).toHaveBeenCalledWith('goal', 'clear');
    await ui.destroy();
  });

  it('runCommand 出错以 notice 呈现,不掀掉 TUI', async () => {
    const { submit, runCommand, ui } = await setup();
    runCommand.mockRejectedValueOnce(new Error('server hiccup'));
    await submit('/goal x');
    await ui.tick();
    expect(ui.frame()).toContain('server hiccup');
    await ui.destroy();
  });

  it('不在扩展表里的名字仍走 unknown 提示', async () => {
    const { submit, runCommand, ui } = await setup();
    await submit('/nope');
    expect(runCommand).not.toHaveBeenCalled();
    expect(ui.frame()).toContain(t('notice.unknownCommand', { name: 'nope' }));
    await ui.destroy();
  });

  it('扩展命令进 `/` 菜单,描述后跟参数提示', async () => {
    const { ui } = await setup();
    await ui.type('/goa');
    await ui.tick();
    expect(ui.frame()).toContain('Keep working · <condition> | clear');
    await ui.destroy();
  });
});

describe('输入框上方的扩展状态行', () => {
  it('有条目时靠右显示文字,带 since 的追加整秒已用时', async () => {
    const { ui } = await setup({
      status: [{ id: 'goal', text: '◎ goal 3/10', since: Date.now() - 64_000 }],
    });
    const line = ui
      .frame()
      .split('\n')
      .find((l) => l.includes('◎ goal 3/10'));
    expect(line).toBeDefined();
    // 整秒展示,不带小数——每秒跳一次尾数只是噪音。
    expect(line).toContain('1m04s');
    // 靠右:前面有一大段留白。
    expect(line).toMatch(/^\s{10,}/);
    await ui.destroy();
  });

  it('没有 since 的条目不带已用时;没有条目时不占行', async () => {
    const { ui, setStatus } = await setup({ status: [{ id: 'goal', text: '◎ goal pending' }] });
    const line = ui
      .frame()
      .split('\n')
      .find((l) => l.includes('◎ goal pending'));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/\d+s/);
    await setStatus([]);
    expect(ui.frame()).not.toContain('◎');
    await ui.destroy();
  });

  it('状态推送到达时这一行跟着出现与消失(extensionsChanged 驱动)', async () => {
    const { ui, setStatus } = await setup();
    expect(ui.frame()).not.toContain('◎');
    await setStatus([{ id: 'goal', text: '◎ goal 1/10', since: Date.now() }]);
    expect(ui.frame()).toContain('◎ goal 1/10');
    await setStatus([]);
    expect(ui.frame()).not.toContain('◎');
    await ui.destroy();
  });

  // 直接渲染组件,把终端宽度压到 30 列(renderUi 支持显式宽度)。
  it('窄终端下截断,不折成两行', async () => {
    const entries = [{ id: 'goal', text: '◎ goal pending — send a message to carry on' }];
    const ui = await renderUi(() => <ExtensionStatusLine entries={() => entries} columns={30} />, {
      width: 30,
      height: 4,
    });
    const rows = ui
      .frame()
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trim().length).toBeLessThanOrEqual(30 - WIDTH_SAFETY);
    expect(rows[0]).toContain('◎');
    await ui.destroy();
  });
});

describe('链条的开关灯', () => {
  it('turn-end 不熄灯(链条可能还有下一轮),run-end 才熄', async () => {
    const { bus, ui } = await setup();
    bus.emit({ type: 'turn-start', userText: 'x' });
    await ui.tick();
    expect(ui.frame()).toContain(t('status.thinking'));
    bus.emit({ type: 'turn-end', usage, finishReason: 'stop' });
    await ui.tick();
    expect(ui.frame()).toContain(t('status.thinking'));
    bus.emit({ type: 'run-end' });
    await ui.tick();
    expect(ui.frame()).not.toContain(t('status.thinking'));
    await ui.destroy();
  });

  it('运行中按 esc 只调 abort——两轮之间的中断由核心丢掉排好的续跑', async () => {
    const { ui, abort } = await setup({ isRunning: true });
    await ui.press('escape');
    await ui.tick();
    expect(abort).toHaveBeenCalledTimes(1);
    await ui.destroy();
  });
});
