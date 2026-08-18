// @vitest-environment jsdom
/**
 * 右键菜单:捕获层关闭、Esc 关闭(内层浮层存在时让位)、条目点选回调、
 * 以及侧栏任务行的右键动作(重命名/归档/分支/复制/删除)。
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextMenu } from '../../src/renderer/components/ContextMenu.js';
import { Sidebar } from '../../src/renderer/components/Sidebar.js';
import { useDesktopStore } from '../../src/renderer/state/desktopStore.js';
import { useProjectsStore } from '../../src/renderer/state/projectsStore.js';
import { useUiStore } from '../../src/renderer/state/uiStore.js';
import { setLocale } from '../../src/renderer/i18n/index.js';
import type { StateSnapshot } from '@core/protocol';
import type { TaskSummary } from '../../src/shared/ipc.js';

const rpcMock = vi.fn().mockResolvedValue(undefined);
const createTaskMock = vi.fn().mockResolvedValue('s-9');

const task = (over: Partial<TaskSummary>): TaskSummary => ({
  id: 's-1',
  root: '/w',
  provider: 'kimi',
  model: 'm',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  title: '修复登录',
  messageCount: 3,
  status: 'connected',
  isRunning: false,
  hasPendingPermission: false,
  ...over,
});

beforeEach(() => {
  setLocale('zh-CN');
  rpcMock.mockClear();
  createTaskMock.mockClear();
  window.mojocode = {
    rpc: rpcMock,
    createTask: createTaskMock,
    openTask: vi.fn().mockResolvedValue('s-1'),
    focusTask: vi.fn().mockResolvedValue(undefined),
    pickDirectory: vi.fn().mockResolvedValue(undefined),
  } as unknown as typeof window.mojocode;
  Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
  useUiStore.setState({ view: 'task', collapsed: false, searchOpen: false });
  useProjectsStore.setState({ projects: ['/w'], selected: null });
  useDesktopStore.setState({
    tasks: [task({})],
    snapshot: { root: '/w', storeId: 's-1', agent: { isRunning: false } } as unknown as StateSnapshot,
    runtimes: {},
    focusedTaskId: 's-1',
  });
});

describe('ContextMenu', () => {
  it('点捕获层关闭;条目点选回调后自关', () => {
    const onClose = vi.fn();
    const onPick = vi.fn();
    const { container } = render(
      <ContextMenu
        x={10}
        y={10}
        title="任务"
        items={[{ id: 'a', label: '动作 A' }]}
        onPick={onPick}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByText('动作 A'));
    expect(onPick).toHaveBeenCalledWith('a');
    expect(onClose).toHaveBeenCalled();

    onClose.mockClear();
    fireEvent.click(document.querySelector('.ctx-capture')!);
    expect(onClose).toHaveBeenCalled();
    expect(container).toBeTruthy();
  });

  it('Esc 关闭;但更内层的 select 浮层存在时让位', () => {
    const onClose = vi.fn();
    render(
      <ContextMenu x={0} y={0} items={[{ id: 'a', label: 'A' }]} onPick={vi.fn()} onClose={onClose} />,
    );
    // 模拟内层 Select 打开:Esc 归它处理。
    const inner = document.createElement('div');
    inner.className = 'select-menu';
    document.body.appendChild(inner);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    inner.remove();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('侧栏任务行右键菜单', () => {
  it('归档 / 分支 / 复制 ID 各走对应通路', () => {
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByText('修复登录'));

    fireEvent.click(screen.getByText('归档任务'));
    expect(rpcMock).toHaveBeenCalledWith({ kind: 'archiveSession', id: 's-1', archived: true });

    fireEvent.contextMenu(screen.getByText('修复登录'));
    fireEvent.click(screen.getByText('创建任务分支'));
    expect(createTaskMock).toHaveBeenCalledWith({ root: '/w', resume: 's-1', fork: true });

    fireEvent.contextMenu(screen.getByText('修复登录'));
    fireEvent.click(screen.getByText('复制会话 ID'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('s-1');
  });

  it('重命名弹出对话框,回车提交 renameSession', () => {
    render(<Sidebar />);
    fireEvent.contextMenu(screen.getByText('修复登录'));
    fireEvent.click(screen.getByText('重命名任务'));
    const input = document.querySelector('.rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '新名字' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(rpcMock).toHaveBeenCalledWith({ kind: 'renameSession', id: 's-1', title: '新名字' });
  });
});
