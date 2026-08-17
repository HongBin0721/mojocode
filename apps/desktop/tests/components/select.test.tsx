// @vitest-environment jsdom
/**
 * 全局选择器组件测试:触发器显示当前项、浮层条目与打勾、点选回调、
 * Esc 只关浮层且不冒泡(设置页整页的 Esc 监听不能被连带触发)。
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Select } from '../../src/renderer/components/Select.js';

const OPTIONS = [
  { value: 'a', label: '甲' },
  { value: 'b', label: '乙' },
  { value: 'c', label: '丙' },
];

describe('Select', () => {
  it('触发器显示当前项;展开列出全部条目,当前项 aria-selected', async () => {
    const user = userEvent.setup();
    render(<Select value="b" options={OPTIONS} ariaLabel="示例" />);
    const trigger = screen.getByRole('button', { name: '示例' });
    expect(trigger.textContent).toContain('乙');
    await user.click(trigger);
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['甲', '乙', '丙']);
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
  });

  it('点选条目回调新值并关闭;点当前项只关闭不回调', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Select value="a" options={OPTIONS} ariaLabel="示例" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: '示例' }));
    await user.click(screen.getByRole('option', { name: '丙' }));
    expect(onChange).toHaveBeenCalledWith('c');
    expect(screen.queryByRole('listbox')).toBeNull();

    await user.click(screen.getByRole('button', { name: '示例' }));
    await user.click(screen.getByRole('option', { name: '甲' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Esc 只关浮层,事件被拦下不冒泡到 document(整页 Esc 监听不触发)', async () => {
    const user = userEvent.setup();
    const pageEsc = vi.fn();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') pageEsc();
    };
    document.addEventListener('keydown', onKey);
    try {
      render(<Select value="a" options={OPTIONS} ariaLabel="示例" />);
      await user.click(screen.getByRole('button', { name: '示例' }));
      expect(screen.getByRole('listbox')).toBeTruthy();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(pageEsc).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onKey);
    }
  });

  it('disabled 触发器不可展开', async () => {
    const user = userEvent.setup();
    render(<Select value="a" disabled options={OPTIONS} ariaLabel="示例" />);
    await user.click(screen.getByRole('button', { name: '示例' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
