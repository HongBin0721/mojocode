// @vitest-environment jsdom
/**
 * 新侧栏(设计稿形态)组件测试:项目树(展开/折叠/切换/拖拽排序)、导航行、
 * 任务行(TONE/打开)、归档过滤与空态。window.mojocode 以 vi.fn 桩替换,
 * store 直接 setState。
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
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
  unseen: false,
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
  useUiStore.setState({
    view: 'task',
    collapsed: false,
    searchOpen: false,
    projectExpanded: {},
    projectShowAll: {},
  });
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
  it('项目树:默认展开,只列未归档任务;运行中转圈,unseen 的显示状态点', () => {
    useDesktopStore.setState({
      tasks: [
        task({ id: 's-1', title: '修复登录', isRunning: true }),
        task({ id: 's-2', title: '写测试', unseen: true }),
        task({ id: 's-3', title: '已归档的', archivedAt: '2026-01-02T00:00:00Z' }),
        task({ id: 's-4', title: '别的项目', root: '/other' }),
      ],
    });
    render(<Sidebar />);
    expect(screen.getByText('修复登录')).toBeTruthy();
    expect(screen.getByText('写测试')).toBeTruthy();
    expect(screen.queryByText('已归档的')).toBeNull();
    expect(screen.queryByText('别的项目')).toBeNull(); // /other 不在项目列表
    // s-1 运行中:旋转指示 + 「运行中」meta(accent 色)。
    const runningRow = screen.getByText('修复登录').closest('.task-row')!;
    expect(runningRow.querySelector('.task-row-spin')).toBeTruthy();
    expect(runningRow.textContent).toContain('运行中');
    // s-2 空闲且 unseen(main 计算下发):TONE 状态点。
    const idleRow = screen.getByText('写测试').closest('.task-row')!;
    expect(idleRow.querySelector('.task-dot')).toBeTruthy();
  });

  it('空会话不进任务列表(聚焦中的新任务也不例外,首条消息落地才出现)', () => {
    useDesktopStore.setState({
      tasks: [
        task({ id: 's-1', title: '修复登录' }),
        task({ id: 's-empty', title: '', messageCount: 0 }),
      ],
      focusedTaskId: 's-empty',
      snapshot: snapshot('/w', 's-empty'),
    });
    render(<Sidebar />);
    expect(screen.getByText('修复登录')).toBeTruthy();
    // 空会话无标题时行会退回 id 前缀显示——它压根不该有行。
    expect(screen.queryByText('s-empty'.slice(0, 8))).toBeNull();
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

  it('unseen 随 tasks 通道更新驱动状态点;聚焦行本地即时熄灭', () => {
    // 聚焦行(s-1,active):即便 unseen=true(main 标记还在路上)也不显示点。
    useDesktopStore.setState({
      tasks: [task({ id: 's-1', title: '修复登录', unseen: true }), task({ id: 's-2', title: '写测试' })],
    });
    render(<Sidebar />);
    const row = (title: string) => screen.getByText(title).closest('.task-row')!;
    expect(row('修复登录').querySelector('.task-dot')).toBeNull();
    expect(row('写测试').querySelector('.task-dot')).toBeNull(); // unseen=false
    // main 推来 s-2 unseen=true(后台跑完一轮)→ 点亮。
    act(() => {
      useDesktopStore.setState({
        tasks: [task({ id: 's-1', title: '修复登录' }), task({ id: 's-2', title: '写测试', unseen: true })],
      });
    });
    expect(row('写测试').querySelector('.task-dot')).toBeTruthy();
  });

  it('项目行 hover「新会话」钮:在该项目 root 下新建任务', () => {
    render(<Sidebar />);
    fireEvent.click(document.querySelector('.project-row-new')!);
    expect(window.mojocode.createTask).toHaveBeenCalledWith({ root: '/w' });
  });

  it('项目行右键:新建会话 / 移出项目', () => {
    render(<Sidebar />);
    fireEvent.contextMenu(document.querySelector('.project-row')!);
    fireEvent.click(screen.getByText('新建会话'));
    expect(window.mojocode.createTask).toHaveBeenCalledWith({ root: '/w' });

    fireEvent.contextMenu(document.querySelector('.project-row')!);
    fireEvent.click(screen.getByText('移出项目'));
    expect(useProjectsStore.getState().projects).toEqual([]);
  });

  it('置顶任务排在最前(togglePin)', () => {
    useProjectsStore.setState({ pinned: ['s-2'] });
    render(<Sidebar />);
    const titles = [...document.querySelectorAll('.task-row-title')].map((el) => el.textContent);
    expect(titles).toEqual(['写测试', '修复登录']);
    expect(document.querySelector('.task-pin')).toBeTruthy();
  });

  it('项目树:全部默认展开;点另一个项目行只切选中,不动展开态', () => {
    useProjectsStore.setState({ projects: ['/w', '/other'] });
    render(<Sidebar />);
    // 设计稿:所有项目默认展开。
    expect(screen.getByText('别的项目')).toBeTruthy();
    expect(screen.getByText('修复登录')).toBeTruthy();
    fireEvent.click(screen.getByText('other'));
    expect(useProjectsStore.getState().selected).toBe('/other');
    expect(screen.getByText('修复登录')).toBeTruthy(); // /w 保持展开
  });

  it('项目树:点箭头只切换展开,不切项目', () => {
    render(<Sidebar />);
    expect(screen.getByText('修复登录')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('折叠项目'));
    expect(screen.queryByText('修复登录')).toBeNull();
    expect(useProjectsStore.getState().selected).toBeNull();
    fireEvent.click(screen.getByLabelText('展开项目'));
    expect(screen.getByText('修复登录')).toBeTruthy();
  });

  it('任务超过 5 条折进「显示更多」,展开后可「收起」', () => {
    useDesktopStore.setState({
      tasks: Array.from({ length: 7 }, (_, i) => task({ id: `m-${i}`, title: `任务${i}` })),
    });
    render(<Sidebar />);
    expect(document.querySelectorAll('.task-row').length).toBe(5);
    fireEvent.click(screen.getByText('显示更多（2）'));
    expect(document.querySelectorAll('.task-row').length).toBe(7);
    fireEvent.click(screen.getByText('收起'));
    expect(document.querySelectorAll('.task-row').length).toBe(5);
  });

  it('项目树:拖拽项目行调整顺序并落 projectsStore', () => {
    useProjectsStore.setState({ projects: ['/w', '/other'] });
    render(<Sidebar />);
    const [first, second] = [...document.querySelectorAll('.project-row')];
    fireEvent.dragStart(first!);
    fireEvent.dragOver(second!);
    fireEvent.drop(second!);
    expect(useProjectsStore.getState().projects).toEqual(['/other', '/w']);
  });

  it('项目树:搜索过滤隐藏整组后拖拽仍按 roots 下标取源项目', () => {
    // /p1 的任务不命中搜索词,整组隐藏——可见行下标(0,1)与 roots 下标(1,2)错位。
    useProjectsStore.setState({ projects: ['/p1', '/w', '/p2'] });
    useDesktopStore.setState({
      tasks: [
        task({ id: 't-p1', title: '甲事', root: '/p1' }),
        task({ id: 's-1', title: '修复任务' }),
        task({ id: 's-4', title: '乙任务', root: '/p2' }),
      ],
    });
    useUiStore.setState({ searchOpen: true });
    render(<Sidebar />);
    fireEvent.change(document.querySelector('.task-search')!, { target: { value: '任务' } });
    const [wRow, p2Row] = [...document.querySelectorAll('.project-row')];
    expect(wRow!.getAttribute('title')).toBe('/w'); // 前置断言:/p1 已被过滤
    fireEvent.dragStart(wRow!);
    fireEvent.dragOver(p2Row!);
    fireEvent.drop(p2Row!);
    // 移动的必须是 /w(roots 下标 1),不是过滤后 groups[1] 的 /p2。
    expect(useProjectsStore.getState().projects).toEqual(['/p1', '/p2', '/w']);
  });
});
