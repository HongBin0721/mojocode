/**
 * `/` 命令菜单浮层:锚定输入框上方的过滤列表,纯展示(键盘处理在
 * Composer 的 onKeyDown,方向键/Enter/Escape 都由它拦截)。
 */

import React from 'react';
import type { CommandEntry } from '../commands/index.js';
import { useLocale } from '../i18n/index.js';

export function SlashMenu({
  entries,
  cursor,
  onHover,
  onPick,
}: {
  entries: CommandEntry[];
  cursor: number;
  onHover: (index: number) => void;
  onPick: (entry: CommandEntry) => void;
}) {
  useLocale();
  if (entries.length === 0) return null;
  return (
    <div className="slash-menu">
      {entries.map((entry, index) => (
        <button
          type="button"
          key={`${entry.source}:${entry.name}`}
          className={`slash-item ${index === cursor ? 'slash-cursor' : ''}`}
          onMouseEnter={() => onHover(index)}
          onMouseDown={(e) => {
            // mousedown 而非 click:textarea 的 blur 不能先发生,否则选区/焦点丢失。
            e.preventDefault();
            onPick(entry);
          }}
        >
          <span className="slash-name">/{entry.name}</span>
          <span className="slash-desc">{entry.description}</span>
          {entry.argumentHint ? <span className="slash-hint">{entry.argumentHint}</span> : null}
        </button>
      ))}
    </div>
  );
}
