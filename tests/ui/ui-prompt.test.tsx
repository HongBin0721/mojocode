import { describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';
import { EventBus } from '../../src/core/events.js';
import type { Session } from '../../src/app/bootstrap.js';
import type { UiRequest } from '../../src/core/extension.js';
import { renderUi } from '../support/otui.js';
import { stubExtensions } from '../support/extensions.js';

/**
 * 扩展提问(ctx.ui.*)在 TUI 里的提示框:镜像里挂着的请求顶掉输入框,
 * select 上下选 + 回车、confirm 的 y/n、input 的打字提交,答案经 answerUi
 * 送回;答过的 id 在下一帧快照到来前不再弹。
 */
async function setup(initial: UiRequest[]) {
  const bus = new EventBus();
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  // 像真 session 一样:answerUi 同步把请求从队列里摘掉并通知订阅者。
  // (App 因此不需要"答过的 id"去重——那是远程时代的补丁。)
  const answerUi = vi.fn((id: string) => {
    const index = requests.findIndex((r) => r.id === id);
    if (index === -1) return;
    requests.splice(index, 1);
    for (const listener of listeners) listener();
  });
  const listeners = new Set<() => void>();
  const requests: UiRequest[] = [...initial];
  const session = {
    root: '/tmp/project',
    config: { statusBar: [] },
    provider,
    agent: {
      isRunning: false,
      isCompacting: false,
      history: [],
      inject: () => false,
      run: vi.fn(async () => {}),
      abort: () => {},
      compact: async () => {},
    },
    bus,
    skills: [],
    skillsChanged: () => () => {},
    ...stubExtensions(),
    get uiRequests() {
      return [...requests];
    },
    answerUi,
    extensionsChanged: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    store: { id: 'test-session', messages: [] },
    switch: () => provider,
    refreshEnvironment: async () => {},
    dispose: async () => {},
  } as unknown as Session;

  const ui = await renderUi(() => <App session={session} />, { width: 100, height: 40 });
  /** 模拟会话进程推来新的一帧:改镜像数组,再通知订阅者。 */
  const setRequests = async (next: UiRequest[]) => {
    requests.splice(0, requests.length, ...next);
    for (const listener of listeners) listener();
    await ui.tick();
  };
  return { ui, answerUi, setRequests };
}

describe('扩展提问提示框', () => {
  it('select:标题与选项可见,↓ + 回车答第二项;答过的不再弹,下一帧清空后回到输入框', async () => {
    const { ui, answerUi, setRequests } = await setup([
      { id: 'ui-1', kind: 'select', title: '选一个分支', items: ['main', 'dev'] },
    ]);
    expect(ui.frame()).toContain('选一个分支');
    expect(ui.frame()).toContain('dev');
    await ui.press('down');
    await ui.press('return');
    await ui.tick();
    expect(answerUi).toHaveBeenCalledWith('ui-1', 'dev');
    expect(ui.frame()).not.toContain('选一个分支');
    await setRequests([]);
    expect(answerUi).toHaveBeenCalledTimes(1);
  });

  it('confirm:n 直接给 false;esc 也给 false', async () => {
    const { ui, answerUi, setRequests } = await setup([
      { id: 'ui-2', kind: 'confirm', title: '继续?', message: '会覆盖 README' },
    ]);
    expect(ui.frame()).toContain('会覆盖 README');
    await ui.press('n');
    await ui.tick();
    expect(answerUi).toHaveBeenCalledWith('ui-2', false);
    await setRequests([{ id: 'ui-3', kind: 'confirm', title: '再问一次', message: 'm' }]);
    await ui.press('escape');
    await ui.tick();
    expect(answerUi).toHaveBeenCalledWith('ui-3', false);
  });

  it('input:打字后回车提交文本;esc 给 undefined', async () => {
    const { ui, answerUi, setRequests } = await setup([
      { id: 'ui-4', kind: 'input', title: '起个名字', placeholder: 'name' },
    ]);
    expect(ui.frame()).toContain('name');
    await ui.type('hong');
    await ui.press('return');
    await ui.tick();
    expect(answerUi).toHaveBeenCalledWith('ui-4', 'hong');
    await setRequests([{ id: 'ui-5', kind: 'input', title: '再来' }]);
    await ui.press('escape');
    await ui.tick();
    expect(answerUi).toHaveBeenCalledWith('ui-5', undefined);
  });
});
