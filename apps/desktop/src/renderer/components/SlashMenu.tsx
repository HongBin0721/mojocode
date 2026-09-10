/**
 * `/` 命令菜单浮层:锚定输入框上方的过滤列表,纯展示(键盘处理在
 * Composer 的 onKeyDown,方向键/Enter/Escape 都由它拦截)。
 *
 * `SlashRow` 是这个浮层与 OptionMenu(扩展命令的选项层)共用的行。两边
 * 曾各写一份,连那句 preventDefault 的注释都是逐字复制的——而它是踩过的
 * 坑(blur 先发生就丢选区/焦点),不该有第二份;`slash-item` 的样式与交互
 * 以后再加东西(窗口化滚动、禁用态)也只有一处要改。
 */

import React from 'react';
import type { CommandEntry } from '../commands/index.js';
import { useLocale } from '../i18n/index.js';

export function SlashRow({
  name,
  description,
  hint,
  active,
  onHover,
  onPick,
}: {
  name: string;
  description?: string;
  /** 行尾的提示位(参数提示、✓、›)。 */
  hint?: React.ReactNode;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className={`slash-item ${active ? 'slash-cursor' : ''}`}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        // mousedown 而非 click:textarea 的 blur 不能先发生,否则选区/焦点丢失。
        e.preventDefault();
        onPick();
      }}
    >
      <span className="slash-name">{name}</span>
      {description ? <span className="slash-desc">{description}</span> : null}
      {hint}
    </button>
  );
}

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
        <SlashRow
          key={`${entry.source}:${entry.name}`}
          name={`/${entry.name}`}
          description={entry.description}
          hint={entry.argumentHint ? <span className="slash-hint">{entry.argumentHint}</span> : null}
          active={index === cursor}
          onHover={() => onHover(index)}
          onPick={() => onPick(entry)}
        />
      ))}
    </div>
  );
}
