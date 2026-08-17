/**
 * 权限档位菜单:四预设(APPROVAL_PRESETS 序)+ plan。full-access 带警示色。
 * 选择只改会话内两轴/plan,不落盘(见 commands/permissions.ts 的说明)。
 *
 * 条目是 ZCode 形态(menu-item-rich):左侧图标,右侧标题行 + 灰描述,
 * 当前项在标题行右端打勾(不用 menu-item-current 的 ::after 勾,那是
 * 单行条目的;rich 变体在 CSS 里关掉它)。
 */

import React, { useContext } from 'react';
import { t, useLocale } from '../i18n/index.js';
import { localizeMode } from '../utils/mode-label.js';
import type { PermissionMenuEntry } from '../commands/permissions.js';
import { MenuCloseContext } from './Menu.js';
import {
  CheckIcon,
  ClipboardIcon,
  EyeIcon,
  HandIcon,
  ShieldCheckIcon,
  UnlockIcon,
} from './icons.js';

const LABEL_KEYS = {
  'read-only': 'approvalopt.readOnly',
  ask: 'approvalopt.ask',
  auto: 'approvalopt.auto',
  'full-access': 'approvalopt.fullAccess',
  plan: 'approvalopt.plan',
} as const;

const ICONS: Record<PermissionMenuEntry['id'], React.ReactNode> = {
  'read-only': <EyeIcon size={15} />,
  ask: <HandIcon size={15} />,
  auto: <ShieldCheckIcon size={15} />,
  plan: <ClipboardIcon size={15} />,
  'full-access': <UnlockIcon size={15} />,
};

export function PermissionMenuList({
  entries,
  onPick,
}: {
  entries: PermissionMenuEntry[];
  onPick: (id: PermissionMenuEntry['id']) => void;
}) {
  useLocale();
  // 点选即关(ZCode 行为):档位切换是本地状态,不必等回执。
  const closeMenu = useContext(MenuCloseContext);
  return (
    <div className="permission-menu">
      {entries.map((entry) => (
        <button
          type="button"
          key={entry.id}
          className={`menu-item menu-item-rich ${entry.current ? 'menu-item-current' : ''} ${
            entry.danger ? 'menu-item-danger' : ''
          }`}
          onClick={() => {
            onPick(entry.id);
            closeMenu();
          }}
        >
          <span className="menu-item-icon">{ICONS[entry.id]}</span>
          <span className="menu-item-body">
            <span className="menu-item-title-row">
              <span className="menu-item-label">{localizeMode(entry.id)}</span>
              {entry.current ? (
                <span className="menu-item-check">
                  <CheckIcon size={13} />
                </span>
              ) : null}
            </span>
            <span className="menu-item-desc">{t(LABEL_KEYS[entry.id])}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
