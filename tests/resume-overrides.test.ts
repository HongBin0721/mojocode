import { describe, expect, it } from 'vitest';
import { resumeOverrides } from '../src/app/resume.js';
import { presetById } from '../src/config/schema.js';
import type { SessionState } from '../src/session/store.js';

const state: SessionState = {
  todos: [],
  allowBash: [],
  allowWrite: [],
  sandbox: 'workspace-write',
  approval: 'on-request',
};

describe('resumeOverrides 优先级矩阵', () => {
  // provider/model 从不并入:恢复的是对话内容,模型始终用当前配置解析出的
  // 那一个(会话 meta 里的只是创建时的记录)。
  it('无 flags:只并入会话记录的两轴权限', () => {
    expect(resumeOverrides(state, {})).toEqual({
      sandbox: 'workspace-write',
      approval: 'on-request',
    });
  });

  it('flags 把两轴都定死了:不并入会话记录的权限', () => {
    expect(resumeOverrides(state, { permissions: presetById('read-only') })).toEqual({});
  });

  it('会话没记权限:不产生任何覆盖', () => {
    expect(resumeOverrides({ ...state, sandbox: undefined, approval: undefined }, {})).toEqual({});
  });

  // 档位一律忠实还原:恢复一个会话就该回到它当时的档位,full-access 也不例外。
  it('会话里存着 danger-full-access 也照样还原', () => {
    expect(
      resumeOverrides({ ...state, sandbox: 'danger-full-access', approval: 'never' }, {}),
    ).toEqual({
      sandbox: 'danger-full-access',
      approval: 'never',
    });
  });

  // 旧版会话文件存的是单轴 permissionMode:一次性映射到两轴。
  it('旧文件的 permissionMode 映射到两轴', () => {
    expect(
      resumeOverrides(
        { ...state, sandbox: undefined, approval: undefined, permissionMode: 'acceptEdits' },
        {},
      ),
    ).toEqual({
      sandbox: 'workspace-write',
      approval: 'on-request',
    });
  });

  // plan 从来不落盘,落了也不该复活;旧 yolo 与新的 full-access 同义,照常映射。
  it('旧文件的 plan 不复活,yolo 映射到 full-access', () => {
    expect(
      resumeOverrides(
        { ...state, sandbox: undefined, approval: undefined, permissionMode: 'plan' },
        {},
      ),
    ).toEqual({});
    expect(
      resumeOverrides(
        { ...state, sandbox: undefined, approval: undefined, permissionMode: 'yolo' },
        {},
      ),
    ).toEqual({
      sandbox: 'danger-full-access',
      approval: 'never',
    });
  });
});
