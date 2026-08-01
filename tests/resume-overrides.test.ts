import { describe, expect, it } from 'vitest';
import { resumeOverrides } from '../src/app/resume.js';
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
  permissionMode: 'acceptEdits',
};

describe('resumeOverrides 优先级矩阵', () => {
  it('无 flags:会话的 provider/model/mode 全部并入', () => {
    expect(resumeOverrides(meta, state, {})).toEqual({
      provider: 'kimi',
      model: 'kimi-k2',
      permissionMode: 'acceptEdits',
    });
  });

  it('flags 给了 provider:meta 的 provider/model 一并放弃(跨 provider 沿用模型会 404)', () => {
    expect(resumeOverrides(meta, state, { provider: 'deepseek' })).toEqual({
      permissionMode: 'acceptEdits',
    });
  });

  it('flags 只给了 model:保留 meta.provider,model 用 flags 的(由上层 overridesFromFlags 覆盖)', () => {
    expect(resumeOverrides(meta, state, { model: 'kimi-k1' })).toEqual({
      provider: 'kimi',
      permissionMode: 'acceptEdits',
    });
  });

  it('flags 给了 mode:不并入会话的 permissionMode', () => {
    expect(resumeOverrides(meta, state, { mode: 'readonly' })).toEqual({
      provider: 'kimi',
      model: 'kimi-k2',
    });
  });

  it('会话没记 mode:不产生 permissionMode 覆盖', () => {
    expect(resumeOverrides(meta, { ...state, permissionMode: undefined }, {})).toEqual({
      provider: 'kimi',
      model: 'kimi-k2',
    });
  });

  it('会话里存着 yolo(旧文件)也不复活:它是"就这一次"的逃生口', () => {
    expect(resumeOverrides(meta, { ...state, permissionMode: 'yolo' }, {})).toEqual({
      provider: 'kimi',
      model: 'kimi-k2',
    });
  });
});
