/**
 * 权限档位菜单:四预设(APPROVAL_PRESETS 序)+ plan。full-access 带警示色。
 * 选择只改会话内两轴/plan,不落盘(见 commands/permissions.ts 的说明)。
 */

import React from 'react';
import { t, useLocale } from '../i18n/index.js';
import type { PermissionMenuEntry } from '../commands/permissions.js';

const LABEL_KEYS = {
  'read-only': 'approvalopt.readOnly',
  ask: 'approvalopt.ask',
  auto: 'approvalopt.auto',
  'full-access': 'approvalopt.fullAccess',
  plan: 'approvalopt.plan',
} as const;

export function PermissionMenuList({
  entries,
  onPick,
}: {
  entries: PermissionMenuEntry[];
  onPick: (id: PermissionMenuEntry['id']) => void;
}) {
  useLocale();
  return (
    <div className="permission-menu">
      {entries.map((entry) => (
        <button
          type="button"
          key={entry.id}
          className={`menu-item ${entry.current ? 'menu-item-current' : ''} ${
            entry.danger ? 'menu-item-danger' : ''
          }`}
          onClick={() => onPick(entry.id)}
        >
          <span className="menu-item-label">{entry.id}</span>
          <span className="menu-item-desc">{t(LABEL_KEYS[entry.id])}</span>
        </button>
      ))}
    </div>
  );
}
