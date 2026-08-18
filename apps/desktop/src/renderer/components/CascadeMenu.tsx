/**
 * 通用级联菜单列表(ZCode 模型选择器形态),放进 MenuPopover 当内容用:
 *  - inline 组:灰字组头 + 条目平铺,当前项右端 ✓;
 *  - submenu 组:一行「label ▸」,悬停(或点击)在右侧浮出二级卡片;
 *  - footer:分隔线下的操作行(如「管理模型」)。
 *
 * 二级卡片经 useAnchoredPortal 挂到 body 用 fixed 定位——宿主 .menu-popover
 * 是 overflow-y:auto,就地 absolute 会被裁剪。随之而来的两个约束:
 *  - 卡片带 data-menu-portal,MenuPopover 的外点检测据此放行,否则
 *    mousedown 先把整个菜单卸载,二级条目的 click 永远到不了;
 *  - 行与卡片之间隔着 6px 空隙,悬停关闭走 120ms 延时(离开行/卡片才
 *    倒计时,进入任一侧取消),否则鼠标滑过空隙的瞬间二级就没了——宿主
 *    滚动收起也走同一延时,与悬停语义一致。
 * 默认往右弹,右缘空间不足翻到左侧。
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPortal } from '../utils/use-anchored-portal.js';
import { ChevronRightIcon } from './icons.js';

export interface CascadeItem {
  id: string;
  label: string;
  note?: string;
  /** 行内小 tag(模型菜单的「思考」)。 */
  tag?: string;
  current?: boolean;
}

export type CascadeSection =
  | { kind: 'inline'; id: string; label?: string; error?: string; items: CascadeItem[] }
  | { kind: 'submenu'; id: string; label: string; error?: string; items: CascadeItem[] };

function ItemButton({ item, onPick }: { item: CascadeItem; onPick: () => void }) {
  return (
    <button
      type="button"
      className={`menu-item cascade-item ${item.current ? 'menu-item-current' : ''}`}
      onClick={onPick}
    >
      <span className="menu-item-label">{item.label}</span>
      {item.tag ? <span className="menu-item-tag">{item.tag}</span> : null}
      {item.note ? <span className="menu-item-note">{item.note}</span> : null}
    </button>
  );
}

function SubmenuRow({
  section,
  open,
  onOpen,
  onPick,
  cancelClose,
  scheduleClose,
}: {
  section: Extract<CascadeSection, { kind: 'submenu' }>;
  open: boolean;
  onOpen: () => void;
  onPick: (itemId: string) => void;
  cancelClose: () => void;
  scheduleClose: () => void;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const subRef = useRef<HTMLDivElement>(null);

  // 右侧放不下翻左;纵向夹回视口由 hook 统一做。
  const pos = useAnchoredPortal({
    open,
    anchorRef: rowRef,
    overlayRef: subRef,
    compute: (anchor, overlay) => {
      const gap = 6;
      const left =
        anchor.right + gap + overlay.width > window.innerWidth - 8
          ? anchor.left - gap - overlay.width
          : anchor.right + gap;
      return { top: anchor.top - 6, left };
    },
    onOutsideScroll: scheduleClose,
  });

  return (
    <>
      <button
        type="button"
        ref={rowRef}
        className="menu-item cascade-item cascade-subtrigger"
        onMouseEnter={onOpen}
        onClick={onOpen}
      >
        <span className="menu-item-label">{section.label}</span>
        <span className="cascade-arrow">
          <ChevronRightIcon size={13} />
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={subRef}
              className="cascade-sub"
              data-menu-portal
              style={pos ?? { visibility: 'hidden', top: 0, left: 0 }}
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
            >
              {section.error ? <div className="menu-error">{section.error}</div> : null}
              {section.items.map((item) => (
                <ItemButton key={item.id} item={item} onPick={() => onPick(item.id)} />
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function CascadeMenuList({
  sections,
  footer,
  onPick,
}: {
  sections: CascadeSection[];
  footer?: { label: React.ReactNode; onClick: () => void };
  onPick: (sectionId: string, itemId: string) => void;
}) {
  const [openSub, setOpenSub] = useState<string | undefined>();
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = () => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpenSub(undefined), 120);
  };
  const openSubNow = (id: string) => {
    cancelClose();
    setOpenSub(id);
  };
  const closeSubNow = () => {
    cancelClose();
    setOpenSub(undefined);
  };
  useEffect(() => cancelClose, []);

  return (
    <div className="cascade-menu" onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
      {sections.map((section) =>
        section.kind === 'inline' ? (
          <div key={section.id} className="cascade-group" onMouseEnter={closeSubNow}>
            {section.label ? <div className="cascade-group-label">{section.label}</div> : null}
            {section.error ? <div className="menu-error">{section.error}</div> : null}
            {section.items.map((item) => (
              <ItemButton key={item.id} item={item} onPick={() => onPick(section.id, item.id)} />
            ))}
          </div>
        ) : (
          <SubmenuRow
            key={section.id}
            section={section}
            open={openSub === section.id}
            onOpen={() => openSubNow(section.id)}
            onPick={(itemId) => onPick(section.id, itemId)}
            cancelClose={cancelClose}
            scheduleClose={scheduleClose}
          />
        ),
      )}
      {footer ? (
        <>
          <div className="cascade-divider" />
          <button
            type="button"
            className="menu-item cascade-item cascade-footer"
            onMouseEnter={closeSubNow}
            onClick={footer.onClick}
          >
            <span className="menu-item-label">{footer.label}</span>
          </button>
        </>
      ) : null}
    </div>
  );
}
