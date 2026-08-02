import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, type EnvironmentInfo } from '../src/agent/prompt.js';
import { presetById } from '../src/config/schema.js';

const env: EnvironmentInfo = {
  root: '/w',
  platform: 'darwin',
  isGitRepo: true,
  gitBranch: 'main',
  projectFiles: ['src/'],
};

const permLine = (prompt: string) =>
  prompt
    .split('\n')
    .find((line) => line.startsWith('- Permissions:') || line.startsWith('- Sandbox:')) ?? '';

describe('计划模式的系统提示词', () => {
  it('附加 Plan mode 段,并指明用 exit_plan 提交方案', () => {
    const prompt = buildSystemPrompt(env, { permissions: presetById('ask'), plan: true });
    expect(prompt).toContain('## Plan mode');
    expect(prompt).toContain('exit_plan');
    // 不能只是"别改文件",还要说清楚不许拿编辑去试探。
    expect(prompt).toMatch(/cannot edit files/);
  });

  it('权限行说明当前不能写入,直到方案获批', () => {
    expect(
      permLine(buildSystemPrompt(env, { permissions: presetById('ask'), plan: true })),
    ).toMatch(/approves your plan/);
  });

  // 别的档位一个字都不该多——多出来的段落是净噪音,还会误导模型去调 exit_plan。
  it('非计划模式不带 Plan mode 段', () => {
    for (const id of ['read-only', 'ask', 'auto', 'full-access'] as const) {
      expect(
        buildSystemPrompt(env, { permissions: presetById(id), plan: false }),
      ).not.toContain('## Plan mode');
    }
  });

  it('read-only 沙箱的权限行说明写入要逐次升级确认', () => {
    expect(
      permLine(buildSystemPrompt(env, { permissions: presetById('read-only'), plan: false })),
    ).toMatch(/escalation/);
  });

  it('never 策略的权限行说明沙箱外的操作直接失败', () => {
    expect(
      permLine(
        buildSystemPrompt(env, {
          permissions: { sandbox: 'workspace-write', approval: 'never' },
          plan: false,
        }),
      ),
    ).toMatch(/just fails/);
  });

  it('ask 预设的权限行写明两轴,不带多余附注', () => {
    expect(permLine(buildSystemPrompt(env, { permissions: presetById('ask'), plan: false }))).toBe(
      '- Sandbox: workspace-write; approval policy: untrusted',
    );
  });
});
