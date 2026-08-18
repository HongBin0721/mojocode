// @vitest-environment jsdom
/**
 * 新侧栏(设计稿形态)组件测试:项目切换器、导航行、任务行(TONE/打开)、
 * 归档过滤与空态。window.mojocode 以 vi.fn 桩替换,store 直接 setState。
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from '../../src/renderer/components/Sidebar.js';
import { useDesktopStore } from '../../src/renderer/state/desktopStore.js';
import { useUiStore } from '../../src/renderer/state/uiStore.js';
import { useProjectsStore } from '../../src/renderer/state/projectsStore.js';
import { setLocale } from '../../src/renderer/i18n/index.js';
import type { StateSnapshot } from '@core/protocol';
import type { TaskSummary } from '../../src/shared/ipc.js';

const task = (over: Partial<TaskSummary>): TaskSummary => ({
  id: 'id',
  root: '/w',
  provider: 'kimi',
  model: 'm',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  title: '任务',
  messageCount: 2,
  status: 'dormant',
  isRunning: false,
  hasPendingPermission: false,
  ...over,
});

const snapshot = (root: string, storeId: string): StateSnapshot =>
  ({
    root,
    storeId,
    provider: {},
    config: {},
    mcpStatuses: [],
    agent: { isRunning: false, isCompacting: false, historyLength: 0 },
    goal: { active: false, busy: false },
    todos: [],
    skills: [],
    sentAt: 0,
  }) as unknown as StateSnapshot;

beforeEach(() => {
  setLocale('zh-CN');
  window.mojocode = {
    rpc: vi.fn().mockResolvedValue(undefined),
    openTask: vi.fn().mockResolvedValue('s-2'),
    createTask: vi.fn().mockResolvedValue('s-9'),
    focusTask: vi.fn().mockResolvedValue(undefined),
    pickDirectory: vi.fn().mockResolvedValue(undefined),
    platform: 'darwin',
  } as unknown as typeof window.mojocode;
  useUiStore.setState({ view: 'task', collapsed: false, searchOpen: false });
  useProjectsStore.setState({ projects: ['/w'], selected: null, pinned: [] });
  useDesktopStore.setState({
    tasks: [
      task({ id: 's-1', title: '修复登录', isRunning: true }),
      task({ id: 's-2', title: '写测试' }),
      task({ id: 's-3', title: '已归档的', archivedAt: '2026-01-02T00:00:00Z' }),
      task({ id: 's-4', title: '别的项目', root: '/other' }),
    ],
    focusedTaskId: 's-1',
    runtimes: { 's-1': { snapshot: snapshot('/w', 's-1'), connection: 'connected', permission: undefined, unread: false } },
    snapshot: snapshot('/w', 's-1'),
    connection: 'connected',
  });
});

describe('Sidebar(设计稿形态)', () => {
  it('只列当前项目的未归档任务,状态·时间双行', () => {
    render(<Sidebar />);
    expect(screen.getByText('修复登录')).toBeTruthy();
    expect(screen.getByText('写测试')).toBeTruthy();
    expect(screen.queryByText('已归档的')).toBeNull();
    expect(screen.queryByText('别的项目')).toBeNull();
    expect(screen.getByText(/运行中 ·/)).toBeTruthy();
  });

  it('点任务行走 openTask 动作', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByText('写测试'));
    expect(window.mojocode.openTask).toHaveBeenCalledWith('s-2');
  });

  it('导航行切视图;归档 badge 计数', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByText('归档'));
    expect(useUiStore.getState().view).toBe('archive');
    // 归档 badge = 1(s-3)。
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('新建任务落在当前项目 root', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByText('新建任务'));
    expect(window.mojocode.createTask).toHaveBeenCalledWith({ root: '/w' });
  });

  it('置顶任务排在最前(togglePin)', () => {
    useProjectsStore.setState({ pinned: ['s-2'] });
    render(<Sidebar />);
    const titles = [...document.querySelectorAll('.task-row-title')].map((el) => el.textContent);
    expect(titles).toEqual(['写测试', '修复登录']);
    expect(document.querySelector('.task-pin')).toBeTruthy();
  });

  it('项目切换器:选另一个项目后任务列表过滤到该 root', () => {
    useProjectsStore.setState({ projects: ['/w', '/other'] });
    render(<Sidebar />);
    fireEvent.click(screen.getByText(/^w$/));
    fireEvent.click(screen.getByText('other'));
    expect(useProjectsStore.getState().selected).toBe('/other');
    expect(screen.getByText('别的项目')).toBeTruthy();
    expect(screen.queryByText('修复登录')).toBeNull();
  });
});
