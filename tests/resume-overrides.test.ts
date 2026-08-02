import { describe, expect, it } from 'vitest';
import { resumeOverrides } from '../src/app/resume.js';
import { presetById } from '../src/config/schema.js';
import type { SessionMeta, SessionState } from '../src/session/store.js';

const meta: SessionMeta = {
  id: 'abc',
  root: '/w',
  provider: 'kimi',
  model: 'kimi-k2',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  title: '',
  messageCount: 2,
};

const state: SessionState = {
  todos: [],
  allowBash: [],
  allowWrite: [],
  sandbox: 'workspace-write',
  approval: 'on-request',
};

describe('resumeOverrides 优先级矩阵', () => {
  it('无 flags:会话的 provider/model/两轴权限全部并入', () => {
    expect(resumeOverrides(meta, state, {})).toEqual({
      provider: 'kimi',
      model: 'kimi-k2',
      sandbox: 'workspace-write',
      approval: 'on-request',
    });
  });

  it('flags 给了 provider:meta 的 provider/model 一并放弃(跨 provider 沿用模型会 404)', () => {
    expect(resumeOverrides(meta, state, { provider: 'deepseek' })).toEqual({
      sandbox: 'workspace-write',
      approval: 'on-request',
    });
  });

  it('flags 只给了 model:保留 meta.provider,model 用 flags 的(由上层 overridesFromFlags 覆盖)', () => {
    expect(resumeOverrides(meta, state, { model: 'kimi-k1' })).toEqual({
      provider: 'kimi',
      sandbox: 'workspace-write',
      approval: 'on-request',
    });
  });

  it('flags 把两轴都定死了:不并入会话记录的权限', () => {
    expect(resumeOverrides(meta, state, { permissions: presetById('read-only') })).toEqual({
      provider: 'kimi',
      model: 'kimi-k2',
    });
  });

  it('会话没记权限:不产生权限覆盖', () => {
    expect(
      resumeOverrides(meta, { ...state, sandbox: undefined, approval: undefined }, {}),
    ).toEqual({
      provider: 'kimi',
      model: 'kimi-k2',
    });
  });

  it('会话里存着 danger-full-access 也不复活:它是"就这一次"的逃生口', () => {
    expect(
      resumeOverrides(
        meta,
        { ...state, sandbox: 'danger-full-access', approval: 'never' },
        {},
      ),
    ).toEqual({
      provider: 'kimi',
      model: 'kimi-k2',
    });
  });

  // 旧版会话文件存的是单轴 permissionMode:一次性映射到两轴。
  it('旧文件的 permissionMode 映射到两轴', () => {
    expect(
      resumeOverrides(
        meta,
        { ...state, sandbox: undefined, approval: undefined, permissionMode: 'acceptEdits' },
        {},
      ),
    ).toEqual({
      provider: 'kimi',
      model: 'kimi-k2',
      sandbox: 'workspace-write',
      approval: 'on-request',
    });
  });

  it('旧文件的 yolo / plan 不复活', () => {
    for (const legacy of ['yolo', 'plan']) {
      expect(
        resumeOverrides(
          meta,
          { ...state, sandbox: undefined, approval: undefined, permissionMode: legacy },
          {},
        ),
      ).toEqual({
        provider: 'kimi',
        model: 'kimi-k2',
      });
    }
  });
});
