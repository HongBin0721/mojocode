// @vitest-environment jsdom
/**
 * use-slash-commands 的 hook 测试(Composer 拆分的配套):输入态派生、
 * tryExecuteSlash 的命中/未命中(消掉 submit 重复匹配后的唯一入口)、
 * 菜单选择的 argumentHint 补全、Esc 压制与查询词变化解除。
 * 底层纯函数(slashState/filterCommands)已在 tests/slash-commands.test.ts。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { StateSnapshot } from '@core/protocol';
import { setLocale } from '../../src/renderer/i18n/index.js';
import { useDesktopStore } from '../../src/renderer/state/desktopStore.js';
import { useSlashCommands } from '../../src/renderer/components/composer/use-slash-commands.js';

const rpcMock = vi.fn<(request: unknown) => Promise<unknown>>();

const snapshot = {
  root: '/tmp/demo',
  provider: { id: 'glm', model: 'GLM-5.3' },
  config: { provider: 'glm', providers: {} },
  mcpStatuses: [],
  storeId: 's1',
  agent: { isRunning: false, isCompacting: false, historyLength: 0 },
  todos: [],
  skills: [{ name: 'release', description: 'ship it', argumentHint: '<version>' }],
  extensions: {
    commands: [
      { name: 'review', description: '评审代码改动', hasOptions: true, selectorTitle: '选择审查预设' },
    ],
    status: [],
  },
  sentAt: 1,
} as unknown as StateSnapshot;

beforeEach(() => {
  setLocale('zh-CN');
  rpcMock.mockReset();
  rpcMock.mockResolvedValue(undefined);
  (window as unknown as { mojocode: unknown }).mojocode = { rpc: rpcMock };
  useDesktopStore.setState({ snapshot });
});

function setup(initialText: string) {
  let text = initialText;
  const setText = vi.fn((next: string) => {
    text = next;
  });
  const view = renderHook(({ value }: { value: string }) => useSlashCommands({ text: value, setText }), {
    initialProps: { value: text },
  });
  return { view, setText, getText: () => text };
}

describe('useSlashCommands', () => {
  it('斜杠输入激活菜单;非斜杠不激活', () => {
    const { view } = setup('/rev');
    expect(view.result.current.menuVisible).toBe(true);
    expect(view.result.current.entries.map((e) => e.name)).toContain('review');
    const plain = setup('hello');
    expect(plain.view.result.current.menuVisible).toBe(false);
    expect(plain.view.result.current.entries).toEqual([]);
  });

  it('tryExecuteSlash:命中命令执行并清空输入,返回 true;未知命令返回 false', () => {
    const { view, setText } = setup('/review src');
    let handled = false;
    act(() => {
      handled = view.result.current.tryExecuteSlash('/review src');
    });
    expect(handled).toBe(true);
    expect(setText).toHaveBeenCalledWith('');
    // 打全了参数就直接执行,不再开选项层。
    expect(rpcMock).toHaveBeenCalledWith({
      kind: 'runCommand',
      name: 'review',
      args: 'src',
    });

    const miss = setup('/unknown-cmd');
    let missHandled = true;
    act(() => {
      missHandled = miss.view.result.current.tryExecuteSlash('/unknown-cmd');
    });
    expect(missHandled).toBe(false);
    expect(miss.setText).not.toHaveBeenCalled();
  });

  it('技能命令走 runSkill,display 带原始输入形态', () => {
    const { view } = setup('/release v1');
    act(() => {
      view.result.current.tryExecuteSlash('/release v1');
    });
    expect(rpcMock).toHaveBeenCalledWith({
      kind: 'runSkill',
      name: 'release',
      args: 'v1',
      display: '/release v1',
    });
  });

  it('菜单选择:带 argumentHint 的技能无参时只补全(不执行)', () => {
    const { view, setText } = setup('/rel');
    const entry = view.result.current.entries.find((e) => e.name === 'release')!;
    act(() => {
      view.result.current.pickFromMenu(entry);
    });
    expect(setText).toHaveBeenCalledWith('/release ');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('扩展命令带取值:菜单选中先开选项层,不直接执行', async () => {
    rpcMock.mockResolvedValue([
      { value: 'base', title: '对比基准分支', expands: true },
      { value: 'uncommitted', title: '审查未提交变更' },
      { value: 'custom', title: '自定义审查说明', prefill: true },
    ]);
    const { view, setText } = setup('/rev');
    const entry = view.result.current.entries.find((e) => e.name === 'review')!;
    await act(async () => {
      view.result.current.pickFromMenu(entry);
    });
    expect(rpcMock).toHaveBeenCalledWith({ kind: 'commandOptions', name: 'review', path: [] });
    expect(setText).toHaveBeenCalledWith('');
    expect(view.result.current.optionMenu?.options).toHaveLength(3);
    expect(view.result.current.optionMenu?.path).toEqual([]);
  });

  it('expands 的选项再开一层;esc 逐层退回;末层提交拼接各层的值', async () => {
    rpcMock.mockResolvedValue([{ value: 'base', title: '对比基准分支', expands: true }]);
    const { view } = setup('/rev');
    const entry = view.result.current.entries.find((e) => e.name === 'review')!;
    await act(async () => {
      view.result.current.pickFromMenu(entry);
    });

    // 第二层:分支列表。
    rpcMock.mockResolvedValue([{ value: 'main', label: 'first commit' }]);
    await act(async () => {
      view.result.current.pickOption({ value: 'base', expands: true });
    });
    expect(rpcMock).toHaveBeenCalledWith({
      kind: 'commandOptions',
      name: 'review',
      path: ['base'],
    });
    expect(view.result.current.optionMenu?.path).toEqual(['base']);

    // esc 退回第一层(重新取值,不是关掉整个菜单)。
    rpcMock.mockResolvedValue([{ value: 'base', title: '对比基准分支', expands: true }]);
    await act(async () => {
      view.result.current.backOption();
    });
    expect(view.result.current.optionMenu?.path).toEqual([]);

    // 末层选中:各层的值以空格拼成 args。
    rpcMock.mockResolvedValue([{ value: 'main', label: 'first commit' }]);
    await act(async () => {
      view.result.current.pickOption({ value: 'base', expands: true });
    });
    rpcMock.mockClear();
    await act(async () => {
      view.result.current.pickOption({ value: 'main' });
    });
    expect(rpcMock).toHaveBeenCalledWith({
      kind: 'runCommand',
      name: 'review',
      args: 'base main',
    });
    expect(view.result.current.optionMenu).toBeUndefined();
  });

  it('prefill 的选项预填输入框(带尾随空格),不执行', async () => {
    rpcMock.mockResolvedValue([{ value: 'custom', title: '自定义', prefill: true }]);
    const { view, setText } = setup('/rev');
    const entry = view.result.current.entries.find((e) => e.name === 'review')!;
    await act(async () => {
      view.result.current.pickFromMenu(entry);
    });
    rpcMock.mockClear();
    await act(async () => {
      view.result.current.pickOption({ value: 'custom', prefill: true });
    });
    expect(setText).toHaveBeenCalledWith('/review custom ');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('某一层取值为空:退回成提交已选的层,由命令自己解释为什么空', async () => {
    rpcMock.mockResolvedValue([]);
    const { view } = setup('/rev');
    const entry = view.result.current.entries.find((e) => e.name === 'review')!;
    await act(async () => {
      view.result.current.pickFromMenu(entry);
    });
    expect(rpcMock).toHaveBeenCalledWith({
      kind: 'runCommand',
      name: 'review',
      args: '',
    });
    expect(view.result.current.optionMenu).toBeUndefined();
  });

  it('Esc 压制菜单;查询词变化后解除', () => {
    const { view } = setup('/rev');
    act(() => {
      view.result.current.suppress();
    });
    expect(view.result.current.menuVisible).toBe(false);
    // 查询词从 rev → revi:onTextChange 解除压制
    act(() => {
      view.result.current.onTextChange('/revi');
    });
    view.rerender({ value: '/revi' });
    expect(view.result.current.menuVisible).toBe(true);
  });
});
