/**
 * 顶部工具栏(Codex 式):模型徽章(开模型菜单)、权限徽章(开档位菜单,
 * full-access 用警示色)、连接状态点、语言切换。徽章变化 2s 高亮闪动。
 */

import React, { useEffect, useRef, useState } from 'react';
import { useDesktopStore } from '../state/desktopStore.js';
import { getLocale, setLocale, t, useLocale, type Locale } from '../i18n/index.js';
import { MenuPopover } from './Menu.js';
import { ModelMenuList } from './ModelMenu.js';
import { PermissionMenuList } from './PermissionMenu.js';
import { isDangerousMode, permissionBadgeLabel, permissionMenuEntries } from '../commands/permissions.js';
import { presetById } from '@core/schema';
import type { RpcRequest } from '../../shared/ipc.js';

const rpc = (request: RpcRequest) => void window.mojocode.rpc(request).catch(console.error);

/** 徽章值变化时闪动 2s(TUI setModeFlash 的 GUI 对应物)。 */
function useFlash(value: string | undefined): boolean {
  const [flash, setFlash] = useState(false);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current !== undefined && prev.current !== value) {
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 2000);
      prev.current = value;
      return () => clearTimeout(timer);
    }
    prev.current = value;
    return;
  }, [value]);
  return flash;
}

export function Toolbar() {
  useLocale();
  const connection = useDesktopStore((s) => s.connection);
  const snapshot = useDesktopStore((s) => s.snapshot);
  const modelMenuRequest = useDesktopStore((s) => s.modelMenuRequest);
  const locale = getLocale();

  const mode = snapshot?.config;
  const badge = mode ? permissionBadgeLabel(mode) : undefined;
  const flash = useFlash(badge);
  const dangerous = mode ? isDangerousMode(mode) : false;
  const entries = mode ? permissionMenuEntries(mode) : [];

  return (
    <header className="toolbar">
      {mode ? (
        <MenuPopover
          label={
            <span className={`badge-mode ${dangerous ? 'badge-danger-mode' : ''} ${flash ? 'badge-flash' : ''}`}>
              {badge}
            </span>
          }
          title={t('permissionMenu.title')}
          width={320}
        >
          <PermissionMenuList
            entries={entries}
            onPick={(id) => {
              if (id === 'plan') rpc({ kind: 'setPlan', active: true });
              else rpc({ kind: 'setPermissions', permissions: presetById(id) });
            }}
          />
        </MenuPopover>
      ) : null}
      {snapshot ? (
        <MenuPopover
          label={
            <span className="badge-model">
              {snapshot.provider.model}
              <span className="badge-caret">⌄</span>
            </span>
          }
          title={t('modelMenu.title')}
          width={360}
          requestOpen={modelMenuRequest}
        >
          <ModelMenuList />
        </MenuPopover>
      ) : null}
      <span className="toolbar-spacer" />
      <span className={`dot dot-${connection}`} title={t(`connection.${connection}` as 'connection.connected')} />
      <button
        type="button"
        className="locale-toggle"
        onClick={() => setLocale(locale === 'zh-CN' ? 'en' : ('zh-CN' as Locale))}
      >
        {locale === 'zh-CN' ? 'EN' : '中文'}
      </button>
    </header>
  );
}
