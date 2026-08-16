/**
 * 权限档位循环(Shift+Tab)与徽章标签:循环逻辑直接复用根仓库
 * src/config/schema.ts 的 nextCycleStep/presetById/permissionsLabel(纯 zod
 * 模块,已在 renderer 白名单)——mojocode 的权限模型本就按 Codex 建模,
 * TUI 与 GUI 的循环语义由同一份函数保证,不做本地复制。
 *
 * GUI 一律**不落盘**:TUI 选框的 savePermissions 走本地 fs,远程客户端
 * 没有那条路径,也不为它新增写 RPC(设置面板在后续迭代)。
 */

import {
  APPROVAL_PRESETS,
  isDangerousPermissions,
  nextCycleStep,
  permissionsLabel,
  presetById,
  type Permissions,
} from '@core/schema';
import type { RpcRequest } from '../../shared/ipc.js';

/** Shift+Tab 的一步:算出下一档并组装成 RPC。纯函数,单测锁定循环序。 */
export function cyclePermissionsRpc(perms: {
  sandbox: Permissions['sandbox'];
  approval: Permissions['approval'];
  plan: boolean;
}): RpcRequest {
  const step = nextCycleStep({ sandbox: perms.sandbox, approval: perms.approval }, perms.plan);
  return 'plan' in step
    ? { kind: 'setPlan', active: true }
    : { kind: 'setPermissions', permissions: presetById(step.preset) };
}

/** 徽章标签:plan 优先,其余用 permissionsLabel(预设名或 sandbox·approval)。 */
export function permissionBadgeLabel(perms: {
  sandbox: Permissions['sandbox'];
  approval: Permissions['approval'];
  plan: boolean;
}): string {
  return perms.plan ? 'plan' : permissionsLabel({ sandbox: perms.sandbox, approval: perms.approval });
}

/** full-access 落档要显式警示(TUI 在时间线留警告,GUI 用徽章警告色 + 闪动)。 */
export function isDangerousMode(perms: {
  sandbox: Permissions['sandbox'];
  approval: Permissions['approval'];
  plan: boolean;
}): boolean {
  return !perms.plan && isDangerousPermissions({ sandbox: perms.sandbox, approval: perms.approval });
}

/** 菜单项:四预设 + plan,展示顺序与 TUI 的 ModePicker 一致(APPROVAL_PRESETS 序)。 */
export interface PermissionMenuEntry {
  id: 'read-only' | 'ask' | 'auto' | 'full-access' | 'plan';
  danger: boolean;
  current: boolean;
}

export function permissionMenuEntries(perms: {
  sandbox: Permissions['sandbox'];
  approval: Permissions['approval'];
  plan: boolean;
}): PermissionMenuEntry[] {
  const presetEntries: PermissionMenuEntry[] = APPROVAL_PRESETS.map((preset) => ({
    id: preset.id,
    danger: isDangerousPermissions({ sandbox: preset.sandbox, approval: preset.approval }),
    current:
      !perms.plan &&
      perms.sandbox === preset.sandbox &&
      perms.approval === preset.approval,
  }));
  return [...presetEntries, { id: 'plan', danger: false, current: perms.plan }];
}
