/**
 * 全局通用选择器(ZCode 形态,替代原生 <select>):触发器沿用输入框度量
 * (图标 + 当前项文案 + 下箭头),展开为浮层卡片,条目带可选图标、当前项
 * 右侧打勾。浮层经 useAnchoredPortal 挂到 body 用 fixed 定位——设置弹窗
 * (.modal-card)是 overflow-y:auto,就地 absolute 会被裁剪/顶出滚动;
 * 落点是 macOS 式:当前项那一行覆盖在触发器正上方(截图里 ZCode 的效果)。
 *
 * Esc 在捕获阶段监听并 stopPropagation(拦住 SettingsPage 的冒泡监听);
 * 展开期间入浮层栈(useOverlayLayer)——外层 Modal 的 Esc 处理器经栈顶判定
 * 主动让位,`.select-menu` 类名从此只是样式,不再是层级仲裁哨兵。
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPortal } from '../utils/use-anchored-portal.js';
import { useOverlayLayer } from './overlays/overlay-stack.js';
import { CheckIcon, ChevronDownIcon } from './icons.js';

export interface SelectOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

export function Select({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
}: {
  value: string;
  options: SelectOption[];
  onChange?: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = options.find((option) => option.value === value);
  // 展开期间入浮层栈:外层 Modal 的 Esc 靠栈顶判定让位(浮层仲裁的新协议)。
  useOverlayLayer(open);

  // 关闭的唯一出口;refocus 只给键盘路径(Esc/点选)——外点/滚动时用户的
  // 注意力已在别处,把焦点抢回触发器反而添乱。
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const pos = useAnchoredPortal({
    open,
    anchorRef: triggerRef,
    overlayRef: menuRef,
    compute: (anchor, overlay, overlayEl) => {
      const selected = overlayEl.querySelector<HTMLElement>('[data-current="true"]');
      return {
        top: selected
          ? anchor.top + anchor.height / 2 - (selected.offsetTop + selected.offsetHeight / 2)
          : anchor.bottom + 4,
        left: anchor.right - Math.max(overlay.width, anchor.width),
        minWidth: anchor.width,
      };
    },
    onOutsideScroll: () => close(false),
  });

  // 落位后把焦点交给当前项(键盘可继续操作)。
  const placed = pos !== undefined;
  useLayoutEffect(() => {
    if (!placed) return;
    const menu = menuRef.current;
    (
      menu?.querySelector<HTMLElement>('[data-current="true"]') ??
      menu?.querySelector<HTMLElement>('.select-option')
    )?.focus({ preventScroll: true });
  }, [placed]);

  // 展开期间:Esc 只关浮层;点浮层外关闭。
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close(true);
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- close 每渲染新引用,闭包内只用稳定 setter/ref。
  }, [open]);

  const pick = (next: string) => {
    close(true);
    if (next !== value) onChange?.(next);
  };

  const onMenuKey = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('.select-option') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, items.length - 1) : Math.max(index - 1, 0);
    items[next]?.focus();
  };

  return (
    <div className="select">
      <button
        type="button"
        ref={triggerRef}
        className="select-trigger"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {current?.icon ? <span className="select-icon">{current.icon}</span> : null}
        <span className="select-value">{current?.label ?? value}</span>
        <span className="select-chevron">
          <ChevronDownIcon size={13} />
        </span>
      </button>
      {open
        ? createPortal(
            <div
              className="select-menu"
              role="listbox"
              aria-label={ariaLabel}
              ref={menuRef}
              style={pos ?? { visibility: 'hidden', top: 0, left: 0 }}
              onKeyDown={onMenuKey}
            >
              {options.map((option) => {
                const selected = option.value === value;
                return (
                  <button
                    type="button"
                    key={option.value}
                    role="option"
                    aria-selected={selected}
                    data-current={selected ? 'true' : undefined}
                    className="select-option"
                    onClick={() => pick(option.value)}
                  >
                    {option.icon ? <span className="select-icon">{option.icon}</span> : null}
                    <span className="select-option-label">{option.label}</span>
                    <span className="select-option-check">
                      {selected ? <CheckIcon size={13} /> : null}
                    </span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
