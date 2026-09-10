import { describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';
import { EventBus } from '../../src/core/events.js';
import type { Session } from '../../src/app/bootstrap.js';
import type { ExtensionCommandOption } from '../../src/core/extension.js';
import { renderUi } from '../support/otui.js';
import { stubExtensions } from '../support/extensions.js';

/**
 * 多级取值选择器(`/review` 的预设 → 分支/提交两级把它逼出来的原语)。
 *
 * 覆盖的是 Input 这一侧的通用行为,与具体是哪个命令无关:标了 `expands`
 * 的项再开一层、`prefill` 的项预填输入框、某一层为空退回成提交已选的层、
 * esc 逐层退回而不是关掉整个选择器。`/review` 自己的取值与失败提示归
 * tests/review-extension.test.ts。
 */
async function setup(options: (path: string[]) => ExtensionCommandOption[]) {
  const bus = new EventBus();
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const commandOptions = vi.fn(async (_name: string, path?: string[]) => options(path ?? []));
  const runCommand = vi.fn(async () => {});
  const session = {
    root: '/tmp/project',
    config: { sandbox: 'workspace-write', approval: 'untrusted', plan: false, statusBar: [] },
    provider,
    agent: {
      isRunning: false,
      isCompacting: false,
      inject: () => false,
      run: vi.fn(async () => {}),
      abort: () => {},
      clear: () => {},
      compact: async () => {},
    },
    bus,
    skills: [],
    skillsChanged: () => () => {},
    ...stubExtensions(),
    extensionCommands: [
      { name: 'demo', description: '多级取值', hasOptions: true, selectorTitle: '选一个' },
    ],
    commandOptions,
    runCommand,
    store: { id: 'test-session', messages: [] },
    switch: () => provider,
    setMode: () => {},
    refreshEnvironment: async () => {},
    dispose: async () => {},
  } as unknown as Session;

  const ui = await renderUi(() => <App session={session} />, { width: 100, height: 45 });
  /** 打开命令菜单并在 /demo 上回车(进第一层选择器)。 */
  const openSelector = async () => {
    await ui.type('/demo');
    await ui.press('return');
    await ui.tick();
  };
  return { ui, commandOptions, runCommand, openSelector };
}

/** 两层:base ▸ 分支列表;uncommitted 直接提交;custom 预填。 */
const twoLevel = (path: string[]): ExtensionCommandOption[] => {
  if (path[0] === 'base') return [{ value: 'main', label: 'first commit' }];
  return [
    { value: 'base', title: '对比基准分支', label: '找 merge-base', expands: true },
    { value: 'uncommitted', title: '审查未提交变更', label: '工作区' },
    { value: 'custom', title: '自定义说明', label: '补关注点', prefill: true },
  ];
};

describe('多级取值选择器', () => {
  it('第一层现取;expands 的项再开一层,path 带上已选的值', async () => {
    const { ui, commandOptions, openSelector } = await setup(twoLevel);
    await openSelector();
    expect(commandOptions).toHaveBeenCalledWith('demo', []);
    expect(ui.frame()).toContain('对比基准分支');

    await ui.press('return'); // 光标在第一项 base
    await ui.tick();
    expect(commandOptions).toHaveBeenCalledWith('demo', ['base']);
    const frame = ui.frame();
    expect(frame).toContain('main');
    expect(frame).toContain('first commit');
    // 标题带面包屑:深层里得看得出自己在哪一层。
    expect(frame).toContain('选一个');
    expect(frame).toContain('base');
  });

  it('末层回车:各层的值以空格拼成参数提交', async () => {
    const { ui, runCommand, openSelector } = await setup(twoLevel);
    await openSelector();
    await ui.press('return');
    await ui.tick();
    await ui.press('return');
    await ui.tick();
    expect(runCommand).toHaveBeenCalledWith('demo', 'base main');
  });

  it('非 expands 的项直接提交单层的值', async () => {
    const { ui, runCommand, openSelector } = await setup(twoLevel);
    await openSelector();
    await ui.press('down'); // uncommitted
    await ui.press('return');
    await ui.tick();
    expect(runCommand).toHaveBeenCalledWith('demo', 'uncommitted');
  });

  it('prefill 的项预填输入框(带尾随空格),不执行', async () => {
    const { ui, runCommand, openSelector } = await setup(twoLevel);
    await openSelector();
    await ui.press('down');
    await ui.press('down'); // custom
    await ui.press('return');
    await ui.tick();
    expect(runCommand).not.toHaveBeenCalled();
    expect(ui.frame()).toContain('/demo custom');
  });

  it('esc 在深层是退回上一层(重新取值),第一层才关掉选择器', async () => {
    const { ui, commandOptions, runCommand, openSelector } = await setup(twoLevel);
    await openSelector();
    await ui.press('return'); // 进 base 层
    await ui.tick();
    expect(ui.frame()).toContain('first commit');

    await ui.press('escape');
    await ui.tick();
    // 回到第一层:又要了一次 path=[] 的取值,分支行不见了。
    expect(commandOptions).toHaveBeenCalledTimes(3);
    expect(commandOptions).toHaveBeenLastCalledWith('demo', []);
    expect(ui.frame()).toContain('对比基准分支');
    expect(ui.frame()).not.toContain('first commit');

    await ui.press('escape');
    await ui.tick();
    expect(ui.frame()).not.toContain('对比基准分支');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('某一层为空:提交已选的层,由命令自己解释为什么空', async () => {
    const { ui, runCommand, openSelector } = await setup((path) =>
      path.length === 0 ? [{ value: 'base', title: '对比基准分支', expands: true }] : [],
    );
    await openSelector();
    await ui.press('return');
    await ui.tick();
    expect(runCommand).toHaveBeenCalledWith('demo', 'base');
  });

  it('第一层就为空:退回成提交裸命令', async () => {
    const { runCommand, openSelector } = await setup(() => []);
    await openSelector();
    expect(runCommand).toHaveBeenCalledWith('demo', '');
  });
});
