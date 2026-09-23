import { describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';
import { EventBus } from '../../src/core/events.js';
import type { Session } from '../../src/app/bootstrap.js';
import type { UiCustomRequest, UiHost, UiRequest, UiSurfaces } from '../../src/core/extension-types.js';
import { t } from '../../src/i18n/index.js';
import { renderUi } from '../support/otui.js';
import { stubExtensions } from '../support/extensions.js';

/**
 * 第五批 Pi 对齐(ctx.ui 余下成员)在 TUI 里的落点:widget 的 belowEditor、
 * setWorkingVisible / setWorkingIndicator / setHiddenThinkingLabel 三个槽位、
 * 覆盖层式的 ui.custom(输入框留在原地)、getToolsExpanded / setToolsExpanded
 * 打到 ctrl+r 的开关、提问框的超时倒计时、原始终端输入先问扩展。
 */
async function setup(initial: { surfaces?: UiSurfaces; customs?: UiCustomRequest[]; requests?: UiRequest[] } = {}) {
  const bus = new EventBus();
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const attachUi = vi.fn();
  const resolveCustom = vi.fn();
  const runTerminalInput = vi.fn((_data: string) => false);
  const listeners = new Set<() => void>();
  let surfaces: UiSurfaces = initial.surfaces ?? { widgets: [] };
  const customs: UiCustomRequest[] = [...(initial.customs ?? [])];
  const requests: UiRequest[] = [...(initial.requests ?? [])];
  const abort = vi.fn();
  let running = false;
  const answerUi = vi.fn((id: string) => {
    const index = requests.findIndex((r) => r.id === id);
    if (index !== -1) requests.splice(index, 1);
    for (const listener of listeners) listener();
  });
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
      run: vi.fn(async () => {}),
      abort,
      compact: async () => {},
    },
    bus,
    skills: [],
    skillsChanged: () => () => {},
    ...stubExtensions(),
    attachUi,
    resolveCustom,
    answerUi,
    runTerminalInput,
    get uiSurfaces() {
      return surfaces;
    },
    get uiCustoms() {
      return [...customs];
    },
    get uiRequests() {
      return [...requests];
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
    runTerminalInput,
    host: () => attachUi.mock.calls[0]![0] as Required<UiHost>,
    setSurfaces: async (next: UiSurfaces) => {
      surfaces = next;
      await notify();
    },
    abort,
    answerUi,
    setRunning: (next: boolean) => {
      running = next;
    },
    setRequests: async (next: UiRequest[]) => {
      requests.splice(0, requests.length, ...next);
      await notify();
    },
    setCustoms: async (next: UiCustomRequest[]) => {
      customs.splice(0, customs.length, ...next);
      await notify();
    },
  };
}

describe('第五批 Pi 对齐的 TUI 落点', () => {
  it('placement: belowEditor 的 widget 画在输入框之下', async () => {
    const { ui, setSurfaces } = await setup();
    await setSurfaces({
      widgets: [
        { key: 'a', surface: ['ABOVE-WIDGET'] },
        { key: 'b', surface: ['BELOW-WIDGET'], placement: 'belowEditor' },
      ],
    });
    const frame = ui.frame();
    const above = frame.indexOf('ABOVE-WIDGET');
    const prompt = frame.indexOf(t('input.placeholder'));
    const below = frame.indexOf('BELOW-WIDGET');
    expect(above).toBeGreaterThanOrEqual(0);
    expect(prompt).toBeGreaterThan(above);
    expect(below).toBeGreaterThan(prompt);
  });

  it('setWorkingVisible(false):跑着也不画工作状态线;恢复后再画', async () => {
    const { ui, bus, setSurfaces } = await setup();
    bus.emit({ type: 'turn-start', userText: 'hi' });
    await ui.tick();
    expect(ui.frame()).toContain(t('status.thinking'));
    await setSurfaces({ widgets: [], workingVisible: false });
    expect(ui.frame()).not.toContain(t('status.thinking'));
    await setSurfaces({ widgets: [] });
    expect(ui.frame()).toContain(t('status.thinking'));
  });

  it('setWorkingIndicator:单帧是静态标记,空数组不画 spinner', async () => {
    const { ui, bus, setSurfaces } = await setup();
    await setSurfaces({ widgets: [], workingIndicator: { frames: ['●'] } });
    bus.emit({ type: 'turn-start', userText: 'hi' });
    await ui.tick();
    expect(ui.frame()).toContain(`● ${t('status.thinking')}`);
    await setSurfaces({ widgets: [], workingIndicator: { frames: [] } });
    const frame = ui.frame();
    expect(frame).toContain(t('status.thinking'));
    expect(frame).not.toContain('●');
    expect(frame).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  it('setHiddenThinkingLabel:折叠的思考块用扩展的标签', async () => {
    const { ui, bus, setSurfaces } = await setup();
    await setSurfaces({ widgets: [], hiddenThinkingLabel: 'PONDERED' });
    bus.emit({ type: 'turn-start', userText: 'hi' });
    bus.emit({ type: 'reasoning-start', id: 'r1' });
    bus.emit({ type: 'reasoning-delta', id: 'r1', text: 'hmm' });
    bus.emit({ type: 'reasoning-end', id: 'r1' });
    await ui.tick();
    expect(ui.frame()).toContain('PONDERED');
    expect(ui.frame()).not.toContain(t('ui.thought'));
  });

  it('overlay 式的 ui.custom:浮在上面、输入区留在原地、键盘归组件;hidden 时不画', async () => {
    const { ui, resolveCustom, setCustoms } = await setup();
    let keys = 0;
    const request: UiCustomRequest = {
      id: 'c1',
      factory: (host) => ({
        render: () => [`OVERLAY-BODY keys=${keys}`],
        handleInput: () => {
          keys += 1;
          host.requestRender();
        },
      }),
      overlay: { width: 40, anchor: 'top-left' },
    };
    await setCustoms([request]);
    let frame = ui.frame();
    expect(frame).toContain('OVERLAY-BODY keys=0');
    // 顶掉输入框的 custom 会把整个输入区(含底栏)换掉;覆盖层不会——底栏的模型名还在。
    expect(frame).toContain('test-model');
    await ui.type('k');
    await ui.tick();
    expect(ui.frame()).toContain('OVERLAY-BODY keys=1');
    expect(resolveCustom).not.toHaveBeenCalled();
    // 把手 setHidden:换引用,组件不重建(keys 不归零),只是不画。
    await setCustoms([{ ...request, hidden: true }]);
    frame = ui.frame();
    expect(frame).not.toContain('OVERLAY-BODY');
    await setCustoms([{ ...request, hidden: false }]);
    expect(ui.frame()).toContain('OVERLAY-BODY keys=1');
  });

  it('getToolsExpanded / setToolsExpanded 与 ctrl+r 是同一个开关', async () => {
    const { ui, host } = await setup();
    expect(host().getToolsExpanded()).toBe(false);
    host().setToolsExpanded(true);
    expect(host().getToolsExpanded()).toBe(true);
    await ui.press('r', { ctrl: true });
    expect(host().getToolsExpanded()).toBe(false);
  });

  it('提问框带 deadline 时提示里倒数', async () => {
    const { ui } = await setup({
      requests: [{ id: 'q1', kind: 'confirm', title: 'T', message: 'M', deadline: Date.now() + 4_900 }],
    });
    expect(ui.frame()).toContain(t('uiPrompt.timeout', { s: 5 }));
  });

  it('原始终端输入先问 session.runTerminalInput;consume 了输入框就收不到', async () => {
    const { ui, host, runTerminalInput } = await setup();
    await ui.type('a');
    expect(runTerminalInput).toHaveBeenCalledWith('a');
    expect(host().getEditorText()).toBe('a');
    runTerminalInput.mockImplementation((data: string) => data === 'z');
    await ui.type('z');
    await ui.type('b');
    await ui.tick();
    expect(host().getEditorText()).toBe('ab');
  });

  it('覆盖层拿着键盘时:扩展提问排在它后面,一次按键不会两处生效;覆盖层收尾后提问才出来', async () => {
    const { ui, answerUi, setCustoms, setRequests } = await setup();
    let keys = 0;
    await setCustoms([
      {
        id: 'c1',
        factory: (host) => ({
          render: () => [`OVL keys=${keys}`],
          handleInput: () => {
            keys += 1;
            host.requestRender();
          },
        }),
        overlay: { width: 30 },
      },
    ]);
    await setRequests([{ id: 'q1', kind: 'confirm', title: 'SURE?', message: 'm' }]);
    expect(ui.frame()).not.toContain('SURE?');
    await ui.type('y');
    await ui.tick();
    expect(keys).toBe(1);
    expect(answerUi).not.toHaveBeenCalled();
    await setCustoms([]);
    expect(ui.frame()).toContain('SURE?');
  });

  it('藏起来的覆盖层把键盘还回去:输入框能打字,提问照常出来', async () => {
    const { ui, host, setCustoms, setRequests } = await setup();
    let keys = 0;
    const request: UiCustomRequest = {
      id: 'c1',
      factory: () => ({
        render: () => ['OVL'],
        handleInput: () => {
          keys += 1;
        },
      }),
      overlay: { visible: (w) => w >= 200 },
    };
    await setCustoms([request]);
    expect(ui.frame()).not.toContain('OVL');
    await ui.type('ab');
    await ui.tick();
    expect(keys).toBe(0);
    expect(host().getEditorText()).toBe('ab');
    await setCustoms([{ ...request, overlay: {}, hidden: true }]);
    await setRequests([{ id: 'q1', kind: 'confirm', title: 'SURE?', message: 'm' }]);
    expect(ui.frame()).toContain('SURE?');
  });

  it('覆盖层挂着、一轮在跑:esc 归中断,不转发给组件;空闲时 esc 才归组件', async () => {
    const { ui, abort, setRunning, setCustoms } = await setup();
    const seen: string[] = [];
    await setCustoms([
      {
        id: 'c1',
        factory: () => ({ render: () => ['OVL'], handleInput: (data) => void seen.push(data) }),
        overlay: {},
      },
    ]);
    setRunning(true);
    await ui.press('escape');
    await ui.tick();
    expect(abort).toHaveBeenCalled();
    expect(seen).toEqual([]);
    setRunning(false);
    await ui.press('escape');
    await ui.tick();
    expect(seen).toEqual(['\x1b']);
  });

  it('没给高度的覆盖层按内容居中,不贴顶', async () => {
    const { ui, setCustoms } = await setup();
    await setCustoms([
      { id: 'c1', factory: () => ({ render: () => ['MID-OVERLAY'] }), overlay: { width: 30 } },
    ]);
    const row = ui.frame().split('\n').findIndex((line) => line.includes('MID-OVERLAY'));
    // 30 行的终端,3 行高的框(1 行内容 + 上下边框)居中:内容行在第 14 行附近。
    expect(row).toBeGreaterThan(10);
    expect(row).toBeLessThan(20);
  });

  it('setHiddenThinkingLabel 中途换掉:已在屏幕上的思考条目也跟着换', async () => {
    const { ui, bus, setSurfaces } = await setup();
    bus.emit({ type: 'turn-start', userText: 'hi' });
    bus.emit({ type: 'reasoning-start', id: 'r1' });
    bus.emit({ type: 'reasoning-delta', id: 'r1', text: 'hmm' });
    bus.emit({ type: 'reasoning-end', id: 'r1' });
    await ui.tick();
    expect(ui.frame()).toContain(t('ui.thought'));
    await setSurfaces({ widgets: [], hiddenThinkingLabel: 'LATE-LABEL' });
    expect(ui.frame()).toContain('LATE-LABEL');
    await setSurfaces({ widgets: [] });
    expect(ui.frame()).not.toContain('LATE-LABEL');
  });

  it('setWorkingIndicator 的 intervalMs 为 0:spinner 照画,不算出 NaN 帧', async () => {
    const { ui, bus, setSurfaces } = await setup();
    await setSurfaces({ widgets: [], workingIndicator: { frames: ['A1', 'B2'], intervalMs: 0 } });
    bus.emit({ type: 'turn-start', userText: 'hi' });
    await ui.tick();
    expect(ui.frame()).toMatch(new RegExp(`(A1|B2) ${t('status.thinking')}`));
  });

  it('覆盖层拿着键盘时整个底部区让出键盘:开着的设置面板也不再收键', async () => {
    const { ui, setCustoms } = await setup();
    await ui.type('/setting');
    await ui.press('return');
    await ui.tick();
    expect(ui.frame()).toContain(t('settings.title'));
    const seen: string[] = [];
    await setCustoms([
      {
        id: 'c1',
        factory: () => ({ render: () => ['OVL'], handleInput: (data) => void seen.push(data) }),
        overlay: { anchor: 'top-left', width: 20 },
      },
    ]);
    // 空闲时 esc 归覆盖层;设置面板若还在收键,它会被这一下关掉。
    await ui.press('escape');
    await ui.tick();
    expect(seen).toEqual(['\x1b']);
    expect(ui.frame()).toContain(t('settings.title'));
  });

  it('流式 delta 比帧间隔还密时 spinner 照样在转(定时器不随每个 delta 重建)', async () => {
    const { ui, bus } = await setup();
    bus.emit({ type: 'turn-start', userText: 'hi' });
    bus.emit({ type: 'text-start', id: 't1' });
    const spinners = new Set<string>();
    for (let i = 0; i < 16; i++) {
      bus.emit({ type: 'text-delta', id: 't1', text: 'x' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      await ui.tick();
      const match = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.exec(ui.frame());
      if (match) spinners.add(match[0]);
    }
    expect(spinners.size).toBeGreaterThan(1);
  });
});

