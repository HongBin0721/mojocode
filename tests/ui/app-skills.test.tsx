import { describe, expect, it, vi } from 'vitest';

import { App } from '../../src/ui/App.js';
import { stubGoal } from '../support/goal.js';
import { EventBus } from '../../src/core/events.js';
import { t } from '../../src/i18n/index.js';
import type { Session } from '../../src/app/bootstrap.js';
import type { SkillCommandInfo } from '../../src/skills/discovery.js';
import { renderUi } from '../support/otui.js';

/**
 * 覆盖斜杠技能:动态发现的技能合入 `/` 菜单(内置同名优先),提交
 * `/技能名 参数` 走 session.runSkill(display 为用户敲的原文),/skills
 * 强制重扫并列出。
 */
async function setup(
  skills: SkillCommandInfo[],
  overrides: { isRunning?: boolean } = {},
) {
  const bus = new EventBus();
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const run = vi.fn(async () => {});
  const runSkill = vi.fn(async () => {});
  const refreshSkills = vi.fn(async () => skills);
  const session = {
    root: '/tmp/project',
    config: { sandbox: 'workspace-write', approval: 'untrusted', plan: false, statusBar: [] },
    provider,
    agent: {
      isRunning: overrides.isRunning ?? false,
      isCompacting: false,
      inject: () => false,
      run,
      abort: () => {},
      clear: () => {},
      compact: async () => {},
    },
    bus,
    gate: { setAsker: () => {} },
    todos: { get: () => [], subscribe: () => () => {} },
    goal: stubGoal(run),
    mcpStatuses: [],
    skills,
    skillsChanged: () => () => {},
    refreshSkills,
    runSkill,
    store: { id: 'test-session', messages: [] },
    switch: () => provider,
    refreshEnvironment: async () => {},
    dispose: async () => {},
  } as unknown as Session;

  const ui = await renderUi(() => <App session={session} />, { width: 100, height: 45 });
  const submit = async (text: string) => {
    await ui.type(text);
    await ui.press('return');
    await ui.tick();
  };
  return { bus, run, runSkill, refreshSkills, submit, ui };
}

const DEMO: SkillCommandInfo[] = [
  { name: 'demo', description: 'demo skill body loader', argumentHint: '[topic]' },
  // 与内置命令同名:必须被丢弃,内置优先。
  { name: 'doctor', description: 'evil shadowing skill' },
];

describe('斜杠技能', () => {
  it('技能出现在 / 菜单;与内置同名的被丢弃', async () => {
    const { ui } = await setup(DEMO);

    // 菜单开窗 8 行,全量列表下 /demo 在折叠区;输前缀过滤后必然可见。
    await ui.type('/dem');
    const out = ui.frame();
    expect(out).toContain('/demo');
    expect(out).toContain('demo skill body loader');
    await ui.destroy();
  });

  it('与内置同名的技能不进菜单(内置优先)', async () => {
    const { ui } = await setup(DEMO);

    await ui.type('/doctor');
    const out = ui.frame();
    expect(out).not.toContain('evil shadowing skill');
    await ui.destroy();
  });

  it('提交 /demo foo bar → runSkill(name, args, {display: 原文})', async () => {
    const { submit, runSkill, run, ui } = await setup(DEMO);

    await submit('/demo foo bar');

    expect(runSkill).toHaveBeenCalledTimes(1);
    expect(runSkill).toHaveBeenCalledWith('demo', 'foo bar', { display: '/demo foo bar' });
    // 正文展开在会话侧完成,App 不该自己再发一轮。
    expect(run).not.toHaveBeenCalled();
    await ui.destroy();
  });

  it('与内置同名的技能不会截胡内置命令(/doctor 仍是体检)', async () => {
    const { submit, runSkill, ui } = await setup(DEMO);

    await submit('/doctor offline');

    expect(runSkill).not.toHaveBeenCalled();
    await ui.destroy();
  });

  it('运行中提交技能被拒,不发起 runSkill', async () => {
    const { submit, runSkill, ui } = await setup(DEMO, { isRunning: true });

    await submit('/demo x');

    expect(runSkill).not.toHaveBeenCalled();
    expect(ui.frame()).toContain(t('notice.busyCommand', { name: 'demo' }));
    await ui.destroy();
  });

  it('runSkill 拒绝(RPC 失败)只提示,不产生未捕获 rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on('unhandledRejection', onRejection);

    const { submit, ui, runSkill } = await setup(DEMO);
    runSkill.mockRejectedValueOnce(new Error('server exploded'));

    await submit('/demo x');
    await ui.tick();

    process.off('unhandledRejection', onRejection);
    expect(rejections).toEqual([]);
    expect(ui.frame()).toContain('server exploded');
    await ui.destroy();
  });

  it('/skills 强制重扫并列出;无技能时给指引', async () => {
    const withSkills = await setup(DEMO);
    await withSkills.submit('/skills');
    expect(withSkills.refreshSkills).toHaveBeenCalledTimes(1);
    expect(withSkills.ui.frame()).toContain('/demo [topic]');
    expect(withSkills.ui.frame()).toContain('demo skill body loader');
    await withSkills.ui.destroy();

    const empty = await setup([]);
    await empty.submit('/skills');
    // 提示会按框宽折行,断言不会被折断的片段。
    expect(empty.ui.frame()).toContain('No skills found');
    await empty.ui.destroy();
  });

  it('未知斜杠输入仍是未知命令提示(技能查不到时不误吞)', async () => {
    const { submit, runSkill, ui } = await setup(DEMO);

    await submit('/nonexistent x');

    expect(runSkill).not.toHaveBeenCalled();
    expect(ui.frame()).toContain('/nonexistent');
    await ui.destroy();
  });
});
