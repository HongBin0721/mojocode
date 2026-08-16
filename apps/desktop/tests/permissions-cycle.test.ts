/**
 * Shift+Tab 权限循环的循环序测试:与 TUI(App.tsx cycleMode → 根 schema 的
 * nextCycleStep)同一语义——read-only→ask→auto→full-access→plan→read-only,
 * 自由组合落 plan。
 */

import { describe, expect, it } from 'vitest';
import { presetById } from '@core/schema';
import {
  cyclePermissionsRpc,
  isDangerousMode,
  permissionBadgeLabel,
  permissionMenuEntries,
} from '../src/renderer/commands/permissions.js';

const perm = (id: 'read-only' | 'ask' | 'auto' | 'full-access') => presetById(id);
const at = (id: 'read-only' | 'ask' | 'auto' | 'full-access' | (string & {}), plan = false) => ({
  ...perm(id as 'ask'),
  plan,
});

describe('cyclePermissionsRpc', () => {
  it('四预设依次递进,尾档落 plan,plan 回 read-only', () => {
    expect(cyclePermissionsRpc(at('read-only'))).toEqual({
      kind: 'setPermissions',
      permissions: perm('ask'),
    });
    expect(cyclePermissionsRpc(at('ask'))).toEqual({
      kind: 'setPermissions',
      permissions: perm('auto'),
    });
    expect(cyclePermissionsRpc(at('auto'))).toEqual({
      kind: 'setPermissions',
      permissions: perm('full-access'),
    });
    expect(cyclePermissionsRpc(at('full-access'))).toEqual({ kind: 'setPlan', active: true });
    expect(cyclePermissionsRpc(at('ask', true))).toEqual({
      kind: 'setPermissions',
      permissions: perm('read-only'),
    });
  });

  it('自由组合(不在预设里)落 plan——写不了任何东西,误触只会收紧', () => {
    expect(cyclePermissionsRpc({ sandbox: 'read-only', approval: 'never', plan: false })).toEqual({
      kind: 'setPlan',
      active: true,
    });
  });

  it('五步回到起点,第六步继续递进', () => {
    let state = at('read-only');
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const rpc = cyclePermissionsRpc(state);
      if (rpc.kind === 'setPlan') {
        state = { ...state, plan: true };
        seen.push('plan');
      } else if (rpc.kind === 'setPermissions') {
        state = { ...rpc.permissions, plan: false };
        seen.push('perm');
      } else {
        throw new Error(`意外的 RPC:${rpc.kind}`);
      }
    }
    // read-only → ask → auto → full-access → plan → read-only(五步一圈),
    // 第六步从 read-only 再推到 ask。
    expect(seen).toEqual(['perm', 'perm', 'perm', 'plan', 'perm', 'perm']);
    expect(state.sandbox).toBe('workspace-write');
    expect(state.approval).toBe('untrusted');
    expect(state.plan).toBe(false);
  });
});

describe('徽章与菜单', () => {
  it('badge 标签:plan 优先,预设显示预设名', () => {
    expect(permissionBadgeLabel(at('ask', true))).toBe('plan');
    expect(permissionBadgeLabel(at('auto'))).toBe('auto');
    expect(permissionBadgeLabel({ sandbox: 'read-only', approval: 'never', plan: false })).toBe(
      'read-only·never',
    );
  });

  it('full-access 判危险;菜单四预设 + plan 且当前项标记正确', () => {
    expect(isDangerousMode(at('full-access'))).toBe(true);
    expect(isDangerousMode(at('auto'))).toBe(false);
    expect(isDangerousMode(at('ask', true))).toBe(false);

    const entries = permissionMenuEntries(at('auto'));
    expect(entries.map((e) => e.id)).toEqual(['read-only', 'ask', 'auto', 'full-access', 'plan']);
    expect(entries.filter((e) => e.current).map((e) => e.id)).toEqual(['auto']);
    expect(entries.filter((e) => e.danger).map((e) => e.id)).toEqual(['full-access']);

    const planEntries = permissionMenuEntries(at('ask', true));
    expect(planEntries.filter((e) => e.current).map((e) => e.id)).toEqual(['plan']);
  });
});
