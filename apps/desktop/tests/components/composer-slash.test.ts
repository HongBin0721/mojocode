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
  goal: { active: false, busy: false },
  todos: [],
  skills: [{ name: 'release', description: 'ship it', argumentHint: '<version>' }],
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
    expect(rpcMock).toHaveBeenCalledWith({ kind: 'startReview', scope: 'src' });

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
