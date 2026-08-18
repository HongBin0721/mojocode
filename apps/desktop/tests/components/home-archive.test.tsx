// @vitest-environment jsdom
/**
 * 首页与归档视图:项目卡汇总、进行中列表、归档表格(过滤/取消归档/打开)。
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HomeView } from '../../src/renderer/components/HomeView.js';
import { ArchiveView } from '../../src/renderer/components/ArchiveView.js';
import { useDesktopStore } from '../../src/renderer/state/desktopStore.js';
import { useProjectsStore } from '../../src/renderer/state/projectsStore.js';
import { useUiStore } from '../../src/renderer/state/uiStore.js';
import { setLocale } from '../../src/renderer/i18n/index.js';
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

const rpcMock = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  setLocale('zh-CN');
  rpcMock.mockClear();
  window.mojocode = {
    rpc: rpcMock,
    openTask: vi.fn().mockResolvedValue('s-1'),
    focusTask: vi.fn().mockResolvedValue(undefined),
  } as unknown as typeof window.mojocode;
  useUiStore.setState({ view: 'home' });
  useProjectsStore.setState({ projects: ['/w', '/other'], selected: null });
  useDesktopStore.setState({
    tasks: [
      task({ id: 's-1', title: '跑测试', isRunning: true }),
      task({ id: 's-2', title: '写文档' }),
      task({ id: 's-3', title: '归档的', archivedAt: '2026-01-05T00:00:00Z' }),
      task({ id: 's-4', title: '别处的', root: '/other' }),
    ],
    runtimes: {},
    focusedTaskId: undefined,
  });
});

describe('HomeView', () => {
  it('项目卡按 root 汇总状态;进行中列表只列 running', () => {
    render(<HomeView />);
    expect(screen.getByText('1 个任务运行中')).toBeTruthy();
    expect(screen.getByText('空闲')).toBeTruthy();
    expect(screen.getByText('跑测试')).toBeTruthy();
    expect(screen.queryByText('写文档')).toBeNull(); // 非运行中
  });

  it('点项目卡切到该项目的任务视图', () => {
    render(<HomeView />);
    fireEvent.click(screen.getByText('other'));
    expect(useProjectsStore.getState().selected).toBe('/other');
    expect(useUiStore.getState().view).toBe('task');
  });
});

describe('ArchiveView', () => {
  it('只列归档任务;取消归档发 RPC 且不触发打开', () => {
    render(<ArchiveView />);
    expect(screen.getByText('归档的')).toBeTruthy();
    expect(screen.queryByText('跑测试')).toBeNull();

    fireEvent.click(screen.getByText('取消归档'));
    expect(rpcMock).toHaveBeenCalledWith({ kind: 'archiveSession', id: 's-3', archived: false });
    expect(useUiStore.getState().view).toBe('home'); // 行点击未被触发
  });

  it('点行重新打开任务并切到任务视图', () => {
    render(<ArchiveView />);
    fireEvent.click(screen.getByText('归档的'));
    expect(window.mojocode.openTask).toHaveBeenCalledWith('s-3');
    expect(useUiStore.getState().view).toBe('task');
  });
});
