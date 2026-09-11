import { describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';
import { EventBus } from '../../src/core/events.js';
import type { Session } from '../../src/app/bootstrap.js';
import type { UiHost, UiSurfaces } from '../../src/core/extension-types.js';
import { renderUi } from '../support/otui.js';
import { stubExtensions } from '../support/extensions.js';

/**
 * 第三批 Pi 对齐在 TUI 里的落点:`!command` 交给 session.runUserBash;
 * `setWorkingMessage` 换掉状态线的阶段文字;`setEditorComponent` 顶替输入框,
 * 组件的 submit 与回车同一条路,草稿读写经 attachUi 的宿主打到组件上;
 * `pasteToEditor` 在缺省输入框的光标处插入。
 */
async function setup(initial: { surfaces?: UiSurfaces } = {}) {
  const bus = new EventBus();
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const runUserBash = vi.fn(async () => {});
  const run = vi.fn(async () => {});
  const abort = vi.fn();
  const attachUi = vi.fn();
  const listeners = new Set<() => void>();
  let surfaces: UiSurfaces = initial.surfaces ?? { widgets: [] };
  let running = false;
  const session = {
    root: '/tmp/project',
    config: { statusBar: [] },
    provider,
    agent: {
      get isRunning() {
        return running;
      },
      isCompacting: false,
      history: [],
      contextUsage: { used: 0, window: 100_000 },
      inject: () => false,
      run,
      abort,
      compact: async () => {},
    },
    bus,
    skills: [],
    skillsChanged: () => () => {},
    ...stubExtensions(),
    attachUi,
    runUserBash,
    get uiSurfaces() {
      return surfaces;
    },
    extensionsChanged: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    store: { id: 'test-session', messages: [] },
    switch: () => provider,
    refreshEnvironment: async () => {},
    dispose: async () => {},
  } as unknown as Session;

  const ui = await renderUi(() => <App session={session} />, { width: 80, height: 30 });
  const host = () => attachUi.mock.calls[0]![0] as Required<UiHost>;
  return {
    ui,
    bus,
    run,
    abort,
    runUserBash,
    host,
    setRunning: (next: boolean) => {
      running = next;
    },
    setSurfaces: async (next: UiSurfaces) => {
      surfaces = next;
      for (const listener of listeners) listener();
      await ui.tick();
    },
  };
}

describe('第三批 Pi 对齐的 TUI 落点', () => {
  it('`!command` 交给 runUserBash,不开轮;裸 `!` 照常当消息', async () => {
    const { ui, run, runUserBash } = await setup();
    await ui.type('!ls -la');
    await ui.press('return');
    await ui.tick();
    expect(runUserBash).toHaveBeenCalledWith('ls -la');
    expect(run).not.toHaveBeenCalled();
    await ui.type('!');
    await ui.press('return');
    await ui.tick();
    expect(runUserBash).toHaveBeenCalledTimes(1);
  });

  it('pasteToEditor 在光标处插入;getEditorText 读到插入后的草稿', async () => {
    const { ui, host } = await setup();
    await ui.type('ab');
    await ui.press('left');
    host().pasteToEditor('X');
    await ui.tick();
    expect(host().getEditorText()).toBe('aXb');
  });

  it('setWorkingMessage 换掉思考中的阶段文字', async () => {
    const { ui, bus, setSurfaces } = await setup();
    await setSurfaces({ widgets: [], workingMessage: 'brewing coffee' });
    bus.emit({ type: 'turn-start', userText: 'hi' });
    await ui.tick();
    expect(ui.frame()).toContain('brewing coffee');
  });

  it('setEditorComponent 顶替输入框:组件收键、submit 走 handleSubmit,草稿读写打到组件上', async () => {
    const { ui, run, host, setSurfaces } = await setup();
    let text = '';
    await setSurfaces({
      widgets: [],
      editor: (_host, submit) => ({
        render: () => [`custom editor: ${text}`],
        handleInput: (data) => {
          if (data === '\r') submit(text);
          else text += data;
        },
        getText: () => text,
        setText: (next) => {
          text = next;
        },
      }),
    });
    expect(ui.frame()).toContain('custom editor:');
    await ui.type('hey');
    await ui.tick();
    expect(ui.frame()).toContain('custom editor: hey');
    expect(host().getEditorText()).toBe('hey');
    host().setEditorText('set');
    host().pasteToEditor('+');
    await ui.tick();
    expect(ui.frame()).toContain('custom editor: set+');
    await ui.press('return');
    await ui.tick();
    expect(run).toHaveBeenCalledWith('set+', undefined);
    // 撤掉之后回到缺省输入框。
    await setSurfaces({ widgets: [] });
    expect(ui.frame()).not.toContain('custom editor');
  });

  it('扩展编辑器挂着时:跑着的 esc 归中断不转发,空闲的 esc 才归组件', async () => {
    const { ui, abort, setRunning, setSurfaces } = await setup();
    const seen: string[] = [];
    await setSurfaces({
      widgets: [],
      editor: () => ({
        render: () => ['ed'],
        handleInput: (data) => {
          seen.push(data);
        },
      }),
    });
    // 空闲:组件收得到 esc(键盘归它)。
    await ui.press('escape');
    await ui.tick();
    expect(seen).toEqual(['\x1b']);
    expect(abort).not.toHaveBeenCalled();
    // 跑着:esc 是中断,不转发——否则一个不处理 esc 的编辑器扩展会让用户
    // 只剩双 ctrl+c 这一条路,而那是退出整个程序。
    setRunning(true);
    await ui.press('escape');
    await ui.tick();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['\x1b']);
  });

  it('pasteToEditor 优先走组件的 insertText(光标语义);没实现才退化成追加', async () => {
    const { ui, host, setSurfaces } = await setup();
    let text = 'ab';
    let cursor = 1;
    await setSurfaces({
      widgets: [],
      editor: () => ({
        render: () => [`cursor editor: ${text}`],
        getText: () => text,
        setText: (next) => {
          text = next;
        },
        insertText: (chunk) => {
          text = text.slice(0, cursor) + chunk + text.slice(cursor);
          cursor += chunk.length;
        },
      }),
    });
    host().pasteToEditor('X');
    await ui.tick();
    expect(ui.frame()).toContain('cursor editor: aXb');

    // 没接 insertText 的组件退化成追加(总好过什么都不发生)。
    let plain = 'ab';
    await setSurfaces({
      widgets: [],
      editor: () => ({
        render: () => [`plain editor: ${plain}`],
        getText: () => plain,
        setText: (next) => {
          plain = next;
        },
      }),
    });
    host().pasteToEditor('X');
    await ui.tick();
    expect(ui.frame()).toContain('plain editor: abX');
  });
});
