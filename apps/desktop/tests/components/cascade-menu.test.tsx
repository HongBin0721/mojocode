// @vitest-environment jsdom
/**
 * 级联菜单组件测试:inline 组平铺与当前项标记、submenu 悬停展开二级
 * (portal 到 body)、悬停离开延时收起、pick 回调、footer 操作行。
 * 附 ModelMenuList 集成:当前 provider 平铺、其他 provider 二级、
 * 点选发 switch RPC 且成功后经 MenuCloseContext 自关。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StateSnapshot } from '@core/protocol';
import { CascadeMenuList, type CascadeSection } from '../../src/renderer/components/CascadeMenu.js';
import { MenuCloseContext } from '../../src/renderer/components/Menu.js';
import { ModelMenuList } from '../../src/renderer/components/ModelMenu.js';
import { useDesktopStore } from '../../src/renderer/state/desktopStore.js';
import { setLocale } from '../../src/renderer/i18n/index.js';

const SECTIONS: CascadeSection[] = [
  {
    kind: 'inline',
    id: 'glm',
    label: 'GLM',
    items: [
      { id: 'GLM-5.3', label: 'GLM-5.3', note: '1.0M', current: true },
      { id: 'GLM-5.2', label: 'GLM-5.2' },
    ],
  },
  {
    kind: 'submenu',
    id: 'deepseek',
    label: 'DeepSeek',
    items: [{ id: 'deepseek-chat', label: 'deepseek-chat' }],
  },
];

describe('CascadeMenuList', () => {
  it('inline 组平铺(组头 + 条目 + 当前项标记);submenu 组折叠为一行', () => {
    render(<CascadeMenuList sections={SECTIONS} onPick={() => {}} />);
    expect(screen.getByText('GLM')).toBeTruthy();
    expect(screen.getByText('GLM-5.3').closest('button')?.className).toContain('menu-item-current');
    expect(screen.getByText('GLM-5.2')).toBeTruthy();
    // 二级未悬停不渲染。
    expect(screen.getByText('DeepSeek')).toBeTruthy();
    expect(screen.queryByText('deepseek-chat')).toBeNull();
  });

  it('悬停 submenu 行展开二级,点条目回调 (sectionId, itemId);移出后延时收起', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<CascadeMenuList sections={SECTIONS} onPick={onPick} />);
    await user.hover(screen.getByText('DeepSeek'));
    await user.click(await screen.findByText('deepseek-chat'));
    expect(onPick).toHaveBeenCalledWith('deepseek', 'deepseek-chat');

    // 移到 inline 组条目上:二级立即收起(closeSubNow,不等延时)。
    await user.hover(screen.getByText('DeepSeek'));
    await screen.findByText('deepseek-chat');
    await user.hover(screen.getByText('GLM-5.2'));
    await waitFor(() => expect(screen.queryByText('deepseek-chat')).toBeNull());
  });

  it('inline 组条目点击回调;footer 行点击回调', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const onFooter = vi.fn();
    render(
      <CascadeMenuList sections={SECTIONS} onPick={onPick} footer={{ label: '管理模型', onClick: onFooter }} />,
    );
    await user.click(screen.getByText('GLM-5.2'));
    expect(onPick).toHaveBeenCalledWith('glm', 'GLM-5.2');
    await user.click(screen.getByText('管理模型'));
    expect(onFooter).toHaveBeenCalled();
  });
});

const rpcMock = vi.fn<(request: unknown) => Promise<unknown>>();

const snapshot = {
  root: '/tmp/demo',
  provider: { id: 'glm', model: 'GLM-5.3', apiKey: '', headers: {} },
  config: {
    provider: 'glm',
    providers: {
      glm: { apiKey: '', models: [{ id: 'GLM-5.3', contextWindow: 1_000_000 }, { id: 'GLM-5.2' }] },
      deepseek: { apiKey: '', models: [{ id: 'deepseek-chat' }] },
    },
  },
  mcpStatuses: [],
  storeId: 's1',
  agent: { isRunning: false, isCompacting: false, historyLength: 0 },
  goal: { active: false, busy: false },
  todos: [],
  skills: [],
  sentAt: 1,
} as unknown as StateSnapshot;

describe('ModelMenuList(级联形态)', () => {
  beforeEach(() => {
    setLocale('zh-CN');
    rpcMock.mockReset();
    rpcMock.mockResolvedValue(undefined);
    (window as unknown as { mojocode: unknown }).mojocode = { rpc: rpcMock };
    useDesktopStore.setState({ snapshot });
  });

  it('当前 provider 组平铺,其他 provider 悬停二级;点选发 switch 并自关菜单', async () => {
    const user = userEvent.setup();
    const closeMenu = vi.fn();
    render(
      <MenuCloseContext.Provider value={closeMenu}>
        <ModelMenuList />
      </MenuCloseContext.Provider>,
    );
    // 当前组(glm)平铺(组头为 preset label),当前模型标记;deepseek 折叠、其模型不可见。
    expect(screen.getByText('GLM (智谱 开放平台)')).toBeTruthy();
    expect(screen.getByText('GLM-5.3').closest('button')?.className).toContain('menu-item-current');
    expect(screen.queryByText('deepseek-chat')).toBeNull();

    await user.hover(screen.getByText('DeepSeek'));
    await user.click(await screen.findByText('deepseek-chat'));
    expect(rpcMock).toHaveBeenCalledWith({
      kind: 'switch',
      change: { provider: 'deepseek', model: 'deepseek-chat' },
    });
    await waitFor(() => expect(closeMenu).toHaveBeenCalled());
  });

  it('「管理模型」跳设置页·模型设置并自关', async () => {
    const user = userEvent.setup();
    const closeMenu = vi.fn();
    render(
      <MenuCloseContext.Provider value={closeMenu}>
        <ModelMenuList />
      </MenuCloseContext.Provider>,
    );
    await user.click(screen.getByText('管理模型'));
    expect(closeMenu).toHaveBeenCalled();
    const { useUiStore } = await import('../../src/renderer/state/uiStore.js');
    expect(useUiStore.getState().view).toBe('settings');
    expect(useUiStore.getState().settingsSection).toBe('models');
  });
});
