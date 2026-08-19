/**
 * Composer 底部工具栏(自 Composer.tsx 拆出):左组附件钮 + 权限档 chip,
 * 右组上下文环 → 模型 → 思考强度 → 发送钮。chips 自读 store,宿主只传
 * 提交/附件回调与发送可用性。
 */

import React, { useRef } from 'react';
import { presetById } from '@core/schema';
import { useModelCapabilities } from '../../utils/use-model-capabilities.js';
import { useDesktopStore } from '../../state/desktopStore.js';
import { rpcFire } from '../../bridge/invoke.js';
import { t, useLocale } from '../../i18n/index.js';
import {
  cyclePermissionsRpc,
  isDangerousMode,
  permissionBadgeLabel,
  permissionMenuEntries,
} from '../../commands/permissions.js';
import { reasoningMenuEntries, setReasoningRpc } from '../../commands/reasoning.js';
import { localizeEffort, localizeMode } from '../../utils/mode-label.js';
import { MenuPopover } from '../Menu.js';
import { ModelMenuList } from '../ModelMenu.js';
import { PermissionMenuList } from '../PermissionMenu.js';
import { ReasoningMenuList } from '../ReasoningMenu.js';
import { ContextRing } from './ContextRing.js';
import { useFlash } from './use-flash.js';
import {
  ArrowUpIcon,
  BrainIcon,
  CaretUpDownIcon,
  CpuIcon,
  PaperclipIcon,
  ShieldCheckIcon,
} from '../icons.js';

export function ComposerToolbar({
  running,
  canSend,
  onPrimary,
  onAddFiles,
}: {
  running: boolean;
  canSend: boolean;
  onPrimary: () => void;
  onAddFiles: (files: Iterable<File>) => void;
}) {
  useLocale();
  const connection = useDesktopStore((s) => s.connection);
  const snapshot = useDesktopStore((s) => s.snapshot);
  const modelMenuRequest = useDesktopStore((s) => s.modelMenuRequest);
  const fileRef = useRef<HTMLInputElement>(null);

  const mode = snapshot?.config;
  const badge = mode ? permissionBadgeLabel(mode) : undefined;
  const flash = useFlash(badge);
  const dangerous = mode ? isDangerousMode(mode) : false;
  const permissionEntries = mode ? permissionMenuEntries(mode) : [];
  const effort = snapshot?.provider.reasoningEffort;
  // 模型条目配了自定义思考参数时档位映射(含 /think)不再生效——chip 显示
  // 「自定义」且不再展开档位菜单,避免选了也没用的假交互。
  const customReasoning = snapshot?.provider.reasoningParams !== undefined;
  // 思考菜单的可选档位:models.dev 逐模型能力(server 侧缓存),查不到 =
  // undefined = 菜单显示全量档位(与之前行为一致)。
  const effortLevels = useModelCapabilities(snapshot?.provider.id, snapshot?.provider.model)
    ?.efforts;

  return (
    <div className="composer-toolbar">
      {/* 左组:+ 附件、盾牌权限档(ZCode 左下角布局) */}
      <div className="composer-tools">
        <button
          type="button"
          className="composer-tool"
          title={t('composer.attach')}
          onClick={() => fileRef.current?.click()}
        >
          <PaperclipIcon size={13} />
          {t('composer.attach')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) onAddFiles(e.target.files);
            e.target.value = '';
          }}
        />
        {mode ? (
          <MenuPopover
            label={
              <span
                className={`composer-tool composer-mode ${dangerous ? 'composer-tool-danger' : ''} ${
                  flash ? 'composer-tool-flash' : ''
                }`}
              >
                <ShieldCheckIcon size={13} />
                {badge && localizeMode(badge)}
                <span className="composer-caret">
                  <CaretUpDownIcon size={11} />
                </span>
              </span>
            }
            width={320}
            placement="top"
          >
            <PermissionMenuList
              entries={permissionEntries}
              onPick={(id) => {
                if (id === 'plan') rpcFire({ kind: 'setPlan', active: true });
                else rpcFire({ kind: 'setPermissions', permissions: presetById(id) });
              }}
            />
          </MenuPopover>
        ) : null}
      </div>
      {/* 右组:上下文环 → 模型 → 思考强度 → 发送(设计稿构成) */}
      <ContextRing />
      {snapshot ? (
        <MenuPopover
          label={
            <span className="composer-tool composer-tool-model">
              <CpuIcon size={13} />
              {snapshot.provider.model}
              <span className="composer-caret">
                <CaretUpDownIcon size={11} />
              </span>
            </span>
          }
          width={360}
          requestOpen={modelMenuRequest}
          placement="top"
          align="end"
        >
          <ModelMenuList />
        </MenuPopover>
      ) : null}
      {customReasoning ? (
        <span className="composer-tool composer-effort" title={t('reasoningMenu.customTitle')}>
          <BrainIcon size={13} />
          {t('effort.custom')}
        </span>
      ) : effortLevels?.length === 0 ? null : effort ? ( // 目录说该模型无思考能力:chip 整个不渲染
        <MenuPopover
          label={
            <span className="composer-tool composer-effort" title={t('reasoningMenu.title')}>
              <BrainIcon size={13} />
              {localizeEffort(effort)}
              <span className="composer-caret">
                <CaretUpDownIcon size={11} />
              </span>
            </span>
          }
          title={t('reasoningMenu.title')}
          width={280}
          placement="top"
          align="end"
        >
          <ReasoningMenuList
            entries={reasoningMenuEntries(effort, effortLevels)}
            onPick={(level) => rpcFire(setReasoningRpc(level))}
          />
        </MenuPopover>
      ) : null}
      <button
        type="button"
        className="composer-send"
        disabled={running ? connection !== 'connected' : !canSend}
        title={running ? t('composer.abort') : t('composer.send')}
        onClick={onPrimary}
      >
        {running ? '■' : <ArrowUpIcon size={15} />}
      </button>
    </div>
  );
}
