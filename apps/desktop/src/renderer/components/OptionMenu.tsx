/**
 * 扩展命令的选项层浮层(`/review` 的预设 → 分支/提交两级就是它)。与
 * SlashMenu 同一个位置、共用它导出的 `SlashRow`,纯展示——键盘处理在
 * Composer 的 onKeyDown,方向键 / Enter / Escape 都由它拦截(Escape 是逐层
 * 退回)。本组件只多一个面包屑标题行与 loading 分支。
 */

import React from 'react';
import { t, useLocale } from '../i18n/index.js';
import { SlashRow } from './SlashMenu.js';
import type { OptionMenuState } from './composer/use-slash-commands.js';

export function OptionMenu({
  state,
  cursor,
  onHover,
  onPick,
}: {
  state: OptionMenuState;
  cursor: number;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
}) {
  useLocale();
  const title = [state.command.selectorTitle ?? `/${state.command.name}`, ...state.path].join(' › ');
  return (
    <div className="slash-menu">
      <div className="slash-menu-title">{title}</div>
      {state.loading ? (
        <div className="slash-menu-note">{t('slash.loadingOptions')}</div>
      ) : (
        state.options.map((option, index) => (
          <SlashRow
            key={option.value}
            name={option.title ?? option.value}
            description={option.label}
            hint={
              <>
                {option.current ? <span className="slash-hint">✓</span> : null}
                {option.expands ? <span className="slash-hint">›</span> : null}
              </>
            }
            active={index === cursor}
            onHover={() => onHover(index)}
            onPick={() => onPick(index)}
          />
        ))
      )}
    </div>
  );
}
