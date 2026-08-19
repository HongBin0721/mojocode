/**
 * 通用 Modal 骨架:统一此前四份手写实现(RenameDialog/DiscardConfirm/
 * ImportProjectDialog/ModelModal)。类名参数化而非统一——两套骨架的 Less
 * (overlay-backdrop/overlay-card 与 modal-overlay/modal-card)都保留,
 * 级联零变化。行为取四者中最完善的一档:
 *  - createPortal 到 body(规避祖先 overflow/transform;backdrop 自身
 *    fixed inset:0,视觉不变);
 *  - backdrop 用 onMouseDown 且 target === currentTarget 才关(取 ModelModal
 *    的写法:卡片内拖选文本松手落在 backdrop 上不该误关);
 *  - Esc 捕获相经浮层栈仲裁:只有栈顶响应,处理后 stopPropagation(内层
 *    Select 弹层开着时它是栈顶,Esc 只关它)。
 */

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayLayer } from './overlay-stack.js';

export function Modal({
  variant,
  cardClassName,
  ariaLabel,
  onClose,
  children,
}: {
  /** overlay → overlay-backdrop/overlay-card;modal → modal-overlay/modal-card。 */
  variant: 'overlay' | 'modal';
  /** 追加在卡片类后的修饰类(如 'overlay-card-sm')。 */
  cardClassName?: string;
  ariaLabel?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const layer = useOverlayLayer(true);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!layer.isTop()) return; // 上面还有浮层(Select 等):让它先关
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // layer 的 isTop 是活引用,不需要进依赖;onClose 变化时重挂。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  const backdropClass = variant === 'overlay' ? 'overlay-backdrop' : 'modal-overlay';
  const cardClass = variant === 'overlay' ? 'overlay-card' : 'modal-card';
  return createPortal(
    <div
      className={backdropClass}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cardClassName ? `${cardClass} ${cardClassName}` : cardClass}
        role="dialog"
        aria-label={ariaLabel}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
