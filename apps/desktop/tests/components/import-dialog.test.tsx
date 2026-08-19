// @vitest-environment jsdom
/**
 * 导入项目对话框:选择文件夹入列表并选中、拖入非文件夹如实提示、Esc 关闭。
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ImportProjectDialog } from '../../src/renderer/components/ImportProjectDialog.js';
import { useProjectsStore } from '../../src/renderer/state/projectsStore.js';
import {
  acquireOverlayLayer,
  resetOverlayStackForTest,
} from '../../src/renderer/components/overlays/overlay-stack.js';
import { setLocale } from '../../src/renderer/i18n/index.js';

beforeEach(() => {
  setLocale('zh-CN');
  resetOverlayStackForTest();
  useProjectsStore.setState({ projects: [], selected: null });
  window.mojocode = {
    pickDirectory: vi.fn().mockResolvedValue('/picked'),
    pathForFile: vi.fn().mockReturnValue('/dropped'),
  } as unknown as typeof window.mojocode;
});

describe('ImportProjectDialog', () => {
  it('「选择文件夹…」:入项目列表、设为当前并关闭', async () => {
    const onClose = vi.fn();
    render(<ImportProjectDialog onClose={onClose} />);
    fireEvent.click(screen.getByText('选择文件夹…'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(useProjectsStore.getState().projects).toEqual(['/picked']);
    expect(useProjectsStore.getState().selected).toBe('/picked');
  });

  it('拖入目录走 pathForFile;拖入普通文件如实提示', () => {
    const onClose = vi.fn();
    const { container } = render(<ImportProjectDialog onClose={onClose} />);
    const drop = container.ownerDocument.querySelector('.import-drop')!;

    const makeTransfer = (isDirectory: boolean) => ({
      items: [{ webkitGetAsEntry: () => ({ isDirectory }) }],
      files: [new File([''], 'x')],
    });

    fireEvent.drop(drop, { dataTransfer: makeTransfer(false) });
    expect(screen.getByText('拖入的不是文件夹')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.drop(drop, { dataTransfer: makeTransfer(true) });
    expect(useProjectsStore.getState().projects).toEqual(['/dropped']);
    expect(onClose).toHaveBeenCalled();
  });

  it('Esc 关闭(上方还有浮层时让位——浮层栈仲裁)', () => {
    const onClose = vi.fn();
    render(<ImportProjectDialog onClose={onClose} />);
    // 模拟内层浮层(Select 等)开着:对话框不是栈顶,Esc 不归它
    const inner = acquireOverlayLayer();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    inner.release();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
