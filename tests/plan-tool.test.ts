import { describe, expect, it, vi } from 'vitest';
import { createExitPlanTool } from '../src/tools/plan.js';
import { PermissionGate } from '../src/permissions/gate.js';
import { EventBus, type PermissionDecision, type PermissionRequest } from '../src/core/events.js';
import { presetById, type Permissions } from '../src/config/schema.js';
import type { ToolContext } from '../src/tools/context.js';
import { summarizeToolResult } from '../src/tools/index.js';
import { t } from '../src/i18n/index.js';

/**
 * 覆盖 exit_plan:计划模式的出口。三条返回都必须是**正常结果**而不是抛错——
 * 方案被打回是正常往复,抛错会在时间线上画成红色的工具报错。
 */
function setup(
  permissions: Permissions,
  decision: PermissionDecision = { type: 'allow' },
  plan = false,
) {
  const bus = new EventBus();
  const asked: PermissionRequest[] = [];
  const ask = vi.fn(async (req: PermissionRequest) => {
    asked.push(req);
    return decision;
  });
  const gate = new PermissionGate({
    root: '/tmp/does-not-matter',
    permissions,
    plan,
    rules: { allowBash: [], denyBash: [], allowWrite: [], denyPath: [] },
    ask,
    bus,
  });
  // 真实实现里由 bootstrap 注入;这里只记录被还原到了哪套组合。
  const switched: Permissions[] = [];
  const exitPlanMode = vi.fn((): Permissions => {
    const restored = presetById('ask');
    switched.push(restored);
    gate.setPlanMode(false);
    return restored;
  });
  const ctx = { gate, exitPlanMode } as unknown as ToolContext;
  const tool = createExitPlanTool(ctx);
  const execute = tool.execute as unknown as (
    input: { plan: string },
    options: unknown,
  ) => Promise<Record<string, unknown>>;
  const run = (plan: string) => execute({ plan }, {});
  return { run, ask, asked, exitPlanMode, switched, gate };
}

describe('exit_plan 工具', () => {
  it('非计划模式下返回纠正信息,不询问、不切模式', async () => {
    const { run, ask, exitPlanMode } = setup(presetById('ask'));
    const result = await run('# 方案');
    expect(result.approved).toBe(false);
    expect(result.notApplicable).toBe(true);
    expect(String(result.message)).toMatch(/only applies in plan mode/);
    expect(ask).not.toHaveBeenCalled();
    expect(exitPlanMode).not.toHaveBeenCalled();
  });

  // readonly 也拒绝一切写入:笼统地说"你已经可以改了"会把模型推去撞
  // assertCanMutate,然后卡在两条互相矛盾的指令之间。
  it('readonly 下不谎称已经可以改动', async () => {
    const { run } = setup({ sandbox: 'read-only', approval: 'never' });
    const message = String((await run('# 方案')).message);
    expect(message).toMatch(/refuses all writes/);
    expect(message).not.toMatch(/you can already make changes/);
  });

  it('宽松模式下才说"直接动手"', async () => {
    for (const id of ['ask', 'auto', 'full-access'] as const) {
      const { run } = setup(presetById(id));
      expect(String((await run('# 方案')).message)).toMatch(/you can already make changes/);
    }
  });

  it('批准后切模式,结果里带上新模式', async () => {
    const { run, exitPlanMode, switched } = setup(presetById('ask'), { type: 'allow' }, true);
    const result = await run('# 方案');
    expect(result.approved).toBe(true);
    expect(result.mode).toBe('ask');
    expect(exitPlanMode).toHaveBeenCalledOnce();
    expect(switched).toEqual([presetById('ask')]);
  });

  // 系统提示词只在开流时读一次,模型本步看到的仍是计划模式那份;不点破的话
  // 它会明明已经能改文件却继续拒绝动手。
  it('批准结果明确点破系统提示词已过期,并要求立刻动手', async () => {
    const { run } = setup(presetById('ask'), { type: 'allow' }, true);
    const message = String((await run('# 方案')).message);
    expect(message).toMatch(/stale/i);
    expect(message).toMatch(/start implementing/i);
  });

  it('批准成 ask 时说明编辑仍需逐次确认', async () => {
    const { run } = setup(presetById('ask'), { type: 'allow' }, true);
    expect(String((await run('# 方案')).message)).toMatch(/confirmed by the user/);
  });

  it('被打回时不切模式,并要求修订后重新提交', async () => {
    const { run, exitPlanMode } = setup(presetById('ask'), { type: 'deny', reason: '再想想缓存失效' }, true);
    const result = await run('# 方案');
    expect(result.approved).toBe(false);
    expect(exitPlanMode).not.toHaveBeenCalled();
    const message = String(result.message);
    expect(message).toContain('再想想缓存失效');
    expect(message).toMatch(/call exit_plan again/);
  });

  it('方案原文进授权请求,供界面渲染', async () => {
    const { run, asked } = setup(presetById('ask'), { type: 'allow' }, true);
    await run('# 方案\n\n1. 改 a.ts');
    expect(asked[0]).toMatchObject({
      kind: 'plan',
      detail: '# 方案\n\n1. 改 a.ts',
    });
  });
});

describe('exit_plan 的时间线摘要', () => {
  it('区分「已批准」「被打回」「压根不在计划模式」', () => {
    expect(summarizeToolResult('exit_plan', { approved: true, mode: 'ask' })).toBe(
      t('sum.planApproved', { mode: 'ask' }),
    );
    expect(summarizeToolResult('exit_plan', { approved: false })).toBe(t('sum.planRejected'));
    // 误调也是 approved:false,但把它说成"用户打回了方案",时间线就在
    // 报告一次根本没发生过的审批。
    expect(summarizeToolResult('exit_plan', { approved: false, notApplicable: true })).toBe(
      t('sum.planNotApplicable'),
    );
  });
});
