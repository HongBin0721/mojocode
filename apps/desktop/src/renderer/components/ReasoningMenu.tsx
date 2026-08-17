/**
 * 思考强度菜单列表:六档(auto/off/low/medium/high/max),档名保持英文
 * (模型参数),说明走 GUI i18n。纯展示,数据由 commands/reasoning.ts 组装。
 */

import React, { useContext } from 'react';
import { t, useLocale } from '../i18n/index.js';
import type { ReasoningMenuEntry } from '../commands/reasoning.js';
import { MenuCloseContext } from './Menu.js';

const DESC_KEYS = {
  auto: 'reasonopt.auto',
  off: 'reasonopt.off',
  low: 'reasonopt.low',
  medium: 'reasonopt.medium',
  high: 'reasonopt.high',
  max: 'reasonopt.max',
} as const;

export function ReasoningMenuList({
  entries,
  onPick,
}: {
  entries: ReasoningMenuEntry[];
  onPick: (level: ReasoningMenuEntry['level']) => void;
}) {
  useLocale();
  // 点选即关(ZCode 行为),与权限菜单一致。
  const closeMenu = useContext(MenuCloseContext);
  return (
    <div className="reasoning-menu">
      {entries.map((entry) => (
        <button
          type="button"
          key={entry.level}
          className={`menu-item ${entry.current ? 'menu-item-current' : ''}`}
          onClick={() => {
            onPick(entry.level);
            closeMenu();
          }}
        >
          <span className="menu-item-label">{entry.level}</span>
          <span className="menu-item-desc">{t(DESC_KEYS[entry.level])}</span>
        </button>
      ))}
    </div>
  );
}
