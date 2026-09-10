import { describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';
import { EventBus } from '../../src/core/events.js';
import type { Session } from '../../src/app/bootstrap.js';
import type {
  ExtensionComponent,
  MessageRenderer,
  ToolRenderers,
  UiCustomRequest,
  UiSurfaces,
} from '../../src/core/extension-types.js';
import { t } from '../../src/i18n/index.js';
import { renderUi } from '../support/otui.js';
import { stubExtensions } from '../support/extensions.js';

/**
 * 扩展渲染层在 TUI 里的落点(Pi 的 ctx.ui.custom / setWidget / setHeader /
 * setFooter 与工具的 renderCall / renderResult):组件顶掉输入框并独占键盘,
 * done 之后经 resolveCustom 交回;区域按扩展给的行画;工具项按扩展的画法画。
 */
async function setup(initial: {
  customs?: UiCustomRequest[];
  surfaces?: UiSurfaces;
  renderers?: Map<string, ToolRenderers>;
  messageRenderers?: Map<string, MessageRenderer>;
}) {
  const bus = new EventBus();
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const resolveCustom = vi.fn();
  const attachUi = vi.fn();
  // 一个「什么都认领」的扩展:内置键绝不能因此失灵。
  const runShortcut = vi.fn(() => true);
  const listeners = new Set<() => void>();
  const customs: UiCustomRequest[] = [...(initial.customs ?? [])];
  let surfaces: UiSurfaces = initial.surfaces ?? { widgets: [] };
  const session = {
    root: '/tmp/project',
    config: { statusBar: [] },
    provider,
    agent: {
      isRunning: false,
      isCompacting: false,
      history: [],
      contextUsage: { used: 0, window: 100_000 },
      inject: () => false,
      run: vi.fn(async () => {}),
      abort: () => {},
      compact: async () => {},
    },
    bus,
    skills: [],
    skillsChanged: () => () => {},
    ...stubExtensions(),
    attachUi,
    runShortcut,
    get uiCustoms() {
      return [...customs];
    },
    resolveCustom,
    get uiSurfaces() {
      return surfaces;
    },
    // 真 session 是"换引用不就地改";测试里直接改传进来的 Map,所以这里
    // 每次读给一份副本来模拟那个身份变化(内容变了身份就变)。
    get toolRenderers() {
      return new Map(initial.renderers ?? []);
    },
    get messageRenderers() {
      return new Map(initial.messageRenderers ?? []);
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
  const notify = async () => {
    for (const listener of listeners) listener();
    await ui.tick();
  };
  return {
    ui,
    bus,
    resolveCustom,
    attachUi,
    runShortcut,
    notify,
    setCustoms: async (next: UiCustomRequest[]) => {
      customs.splice(0, customs.length, ...next);
      await notify();
    },
    setSurfaces: async (next: UiSurfaces) => {
      surfaces = next;
      await notify();
    },
  };
}

/** 一个 Pi 风格的组件:两行文字,↓ 换选中项,回车 done(选中项),esc done(undefined)。 */
function pickerComponent(done: (value: unknown) => void, requestRender: () => void): ExtensionComponent {
  const items = ['alpha', 'beta'];
  let cursor = 0;
  return {
    render: (width) => [`custom picker ${width}`, ...items.map((item, i) => `${i === cursor ? '>' : ' '} ${item}`)],
    handleInput: (data) => {
      if (data === '\x1b[B') {
        cursor = (cursor + 1) % items.length;
        requestRender();
      } else if (data === '\r') done(items[cursor]);
      else if (data === '\x1b') done(undefined);
    },
  };
}

describe('扩展渲染层', () => {
  it('挂载即 attachUi(有人在看)', async () => {
    const { attachUi } = await setup({});
    expect(attachUi).toHaveBeenCalled();
    const host = attachUi.mock.calls[0]![0] as { available: () => boolean };
    expect(host.available()).toBe(true);
  });

  it('快捷键:带修饰键的组合先问扩展,认领了就不再往下走;编辑框草稿经宿主读写', async () => {
    const { ui, attachUi, runShortcut } = await setup({});
    await ui.press('g', { ctrl: true });
    await ui.tick();
    expect(runShortcut).toHaveBeenCalledWith('ctrl+g');
    // 内置键排在扩展派发之前:即便扩展声称认领,ctrl+c 仍走双击退出。
    await ui.press('c', { ctrl: true });
    await ui.tick();
    expect(ui.frame()).toContain(t('status.ctrlcAgain'));
    expect(runShortcut).not.toHaveBeenCalledWith('ctrl+c');
    const host = attachUi.mock.calls[0]![0] as { getEditorText: () => string; setEditorText: (t: string) => void };
    await ui.type('hello');
    await ui.tick();
    expect(host.getEditorText()).toBe('hello');
    host.setEditorText('replaced');
    await ui.tick();
    expect(host.getEditorText()).toBe('replaced');
    expect(ui.frame()).toContain('replaced');
  });

  it('session-changed:new 只留横幅,resume 回放展示历史', async () => {
    const { ui, bus } = await setup({});
    bus.emit({ type: 'turn-start', userText: 'first question' });
    await ui.tick();
    expect(ui.frame()).toContain('first question');
    bus.emit({ type: 'session-changed', reason: 'new', id: 'new-id' });
    await ui.tick();
    expect(ui.frame()).not.toContain('first question');
  });

  it('ui.custom:组件顶掉输入框、收到按键、done 经 resolveCustom 交回,且只交一次', async () => {
    const { ui, resolveCustom } = await setup({
      customs: [{ id: 'c1', factory: (host, done) => pickerComponent(done, host.requestRender) }],
    });
    expect(ui.frame()).toContain('custom picker 80');
    expect(ui.frame()).toContain('> alpha');
    await ui.press('down');
    await ui.tick();
    expect(ui.frame()).toContain('> beta');
    await ui.press('return');
    await ui.tick();
    expect(resolveCustom).toHaveBeenCalledWith('c1', 'beta');
    await ui.press('escape');
    await ui.tick();
    expect(resolveCustom).toHaveBeenCalledTimes(1);
  });

  it('setWidget / setHeader / setFooter:行与组件都画出来,footer 替换缺省底栏', async () => {
    const { ui, setSurfaces } = await setup({});
    await setSurfaces({
      widgets: [
        { key: 'w1', surface: ['widget line one'] },
        { key: 'w2', surface: (host) => ({ render: (w) => [`widget component ${w} ${host.theme.bold('B')}`] }) },
      ],
      header: ['header from extension'],
      footer: ['footer from extension'],
    });
    const frame = ui.frame();
    expect(frame).toContain('widget line one');
    expect(frame).toContain('widget component 80 B');
    expect(frame).toContain('header from extension');
    expect(frame).toContain('footer from extension');
    await setSurfaces({ widgets: [] });
    expect(ui.frame()).not.toContain('footer from extension');
    expect(ui.frame()).not.toContain('header from extension');
  });

  it('自定义消息:有画法按画法画,没有就 [type] 标签加正文', async () => {
    const { ui, bus } = await setup({
      messageRenderers: new Map<string, MessageRenderer>([['note', (m) => [`NOTE ${m.content}`]]]),
    });
    bus.emit({ type: 'custom-message', customType: 'note', content: 'hello' });
    bus.emit({ type: 'custom-message', customType: 'other', content: 'raw', display: 'shown' });
    await ui.tick();
    const frame = ui.frame();
    expect(frame).toContain('NOTE hello');
    expect(frame).toContain('[other]');
    expect(frame).toContain('shown');
    expect(frame).not.toContain('raw');
  });

  it('画法是**后来**注册的:已经画在时间线上的行也重画', async () => {
    const messageRenderers = new Map<string, MessageRenderer>();
    const { ui, bus, notify } = await setup({ messageRenderers });
    bus.emit({ type: 'custom-message', customType: 'late', content: 'body' });
    await ui.tick();
    expect(ui.frame()).toContain('[late]');
    messageRenderers.set('late', (m) => [`LATE ${m.content}`]);
    await notify();
    expect(ui.frame()).toContain('LATE body');
    expect(ui.frame()).not.toContain('[late]');
  });

  it('renderCall / renderResult:时间线里的工具项按扩展的画法画', async () => {
    const renderers = new Map<string, ToolRenderers>([
      [
        'demo',
        {
          renderCall: (input) => [`CALL ${(input as { x: string }).x}`],
          renderResult: (output, { isError }) => [`RESULT ${String(output)} ${isError ? 'ERR' : 'OK'}`],
        },
      ],
    ]);
    const { ui, bus } = await setup({ renderers });
    bus.emit({ type: 'turn-start', userText: 'go' });
    bus.emit({ type: 'tool-start', callId: 't1', toolName: 'demo', input: { x: 'hi' } });
    bus.emit({
      type: 'tool-end',
      callId: 't1',
      toolName: 'demo',
      summary: 'default summary',
      output: 'done',
      isError: false,
      durationMs: 5,
    });
    await ui.tick();
    const frame = ui.frame();
    expect(frame).toContain('CALL hi');
    expect(frame).toContain('RESULT done OK');
    expect(frame).not.toContain('default summary');
  });
});
