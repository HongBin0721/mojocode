// @vitest-environment jsdom
/**
 * 浮层栈与通用 Modal 的行为锁:栈顶判定、release 幂等、Modal 的 Esc 仲裁
 * (栈顶才关)与 backdrop 点关语义。
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  acquireOverlayLayer,
  resetOverlayStackForTest,
} from '../../src/renderer/components/overlays/overlay-stack.js';
import { Modal } from '../../src/renderer/components/overlays/Modal.js';

beforeEach(() => {
  cleanup();
  resetOverlayStackForTest();
});

describe('overlay-stack', () => {
  it('后入栈者是栈顶;release 后让位;release 幂等', () => {
    const a = acquireOverlayLayer();
    const b = acquireOverlayLayer();
    expect(a.isTop()).toBe(false);
    expect(b.isTop()).toBe(true);
    b.release();
    expect(a.isTop()).toBe(true);
    b.release(); // 幂等,不影响 a
    expect(a.isTop()).toBe(true);
    a.release();
    expect(a.isTop()).toBe(false);
  });
});

describe('Modal', () => {
  it('portal 到 body,按 variant 出对应类名', () => {
    render(
      <Modal variant="overlay" cardClassName="overlay-card-sm" ariaLabel="rename" onClose={() => {}}>
        <div>content</div>
      </Modal>,
    );
    const card = screen.getByRole('dialog', { name: 'rename' });
    expect(card.className).toBe('overlay-card overlay-card-sm');
    expect(document.body.querySelector('.overlay-backdrop')).not.toBeNull();
  });

  it('Esc:自己是栈顶时关闭并 stopPropagation;上方有浮层时不动', () => {
    const onClose = vi.fn();
    const outer = vi.fn();
    document.addEventListener('keydown', outer); // 冒泡相的外层监听(如 SettingsPage 关整页)
    render(
      <Modal variant="modal" ariaLabel="m" onClose={onClose}>
        <div>content</div>
      </Modal>,
    );
    // 模拟内层 Select 弹层开着:Modal 不再是栈顶
    const inner = acquireOverlayLayer();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    inner.release();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    // 捕获相已 stopPropagation:冒泡相监听收不到这次 Esc
    expect(outer).toHaveBeenCalledTimes(1); // 只有内层浮层开着的那次穿透
    document.removeEventListener('keydown', outer);
  });

  it('backdrop mousedown 且 target===currentTarget 才关(卡片内点击不关)', () => {
    const onClose = vi.fn();
    render(
      <Modal variant="overlay" ariaLabel="m" onClose={onClose}>
        <div>content</div>
      </Modal>,
    );
    fireEvent.mouseDown(screen.getByText('content'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body.querySelector('.overlay-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
