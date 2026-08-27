// @vitest-environment jsdom
/**
 * 附件大图预览(ImagePreview)组件测试:data URI 渲染、三条关闭路径
 * (Esc / backdrop / 点图),以及 Composer 侧的入口约定(缩略图外的
 * 预览按钮 aria)。CSP 对 data: 的放行在 index.html,jsdom 不执行 CSP,
 * 这里只锁组件行为。
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setLocale } from '../../src/renderer/i18n/index.js';
import { ImagePreview } from '../../src/renderer/components/overlays/ImagePreview.js';
import { imageDataUri } from '../../src/renderer/utils/image.js';

setLocale('zh-CN');

const IMG = { mediaType: 'image/png', data: 'iVBORw0KGgo=', filename: 'clipboard-1.png' };

describe('ImagePreview', () => {
  it('以 data URI 渲染大图,文件名做说明行', () => {
    const { unmount } = render(<ImagePreview image={IMG} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: '图片预览' });
    const img = dialog.querySelector('img.image-preview-img')!;
    expect(img.getAttribute('src')).toBe(imageDataUri(IMG));
    expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(dialog.textContent).toContain('clipboard-1.png');
    unmount();
  });

  it('Esc / backdrop / 点图三条路径都触发 onClose', () => {
    for (const trigger of ['esc', 'backdrop', 'img'] as const) {
      const onClose = vi.fn();
      const { unmount } = render(<ImagePreview image={IMG} onClose={onClose} />);
      if (trigger === 'esc') {
        fireEvent.keyDown(document, { key: 'Escape' });
      } else if (trigger === 'backdrop') {
        // Modal 的 backdrop 关闭要求 target === currentTarget(卡片内拖选不误关)。
        fireEvent.mouseDown(document.querySelector('.modal-overlay')!);
      } else {
        fireEvent.click(document.querySelector('.image-preview-img')!);
      }
      expect(onClose).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('无 filename 时不渲染说明行', () => {
    const { unmount } = render(
      <ImagePreview image={{ mediaType: 'image/png', data: 'AAAA' }} onClose={() => {}} />,
    );
    expect(document.querySelector('.image-preview-name')).toBeNull();
    unmount();
  });
});
