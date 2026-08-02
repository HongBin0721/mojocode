import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadRawConfig } from '../src/config/load.js';

/**
 * 旧版单轴 permissionMode 的一次性迁移。
 *
 * 核心不变量:迁移**只能填空,不能放宽**。早先的实现要求两个新键都缺才整体
 * 映射,同一层混写新旧键时(`{permissionMode:"readonly", approval:"on-request"}`)
 * 会把 readonly 整个丢掉、sandbox 落回默认的 workspace-write——用户要只读,
 * 拿到可写沙箱,而且一声不吭。
 */
let home: string;
let root: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-legacy-'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-root-'));
  process.env.HOME = home;
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
});

async function writeGlobal(json: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(home, '.mojocode'), { recursive: true });
  await fs.writeFile(path.join(home, '.mojocode', 'config.json'), JSON.stringify(json));
}

/** 传空 env,免得开发机上真实的 MOJOCODE_* 变量干扰断言。 */
const load = () => loadRawConfig({ root, env: {} as NodeJS.ProcessEnv });

describe('旧版 permissionMode 的迁移', () => {
  it('两个新键都缺:整体映射并提示', async () => {
    await writeGlobal({ permissionMode: 'readonly' });
    const { config, warnings } = await load();
    expect(config.sandbox).toBe('read-only');
    expect(config.approval).toBe('never');
    expect(warnings.join()).toMatch(/old single-axis/);
  });

  // 回归:这是评审发现的静默放宽。
  it('只写了 approval:仍从旧值补出 sandbox,绝不落回可写默认', async () => {
    await writeGlobal({ permissionMode: 'readonly', approval: 'on-request' });
    const { config, warnings } = await load();
    expect(config.sandbox).toBe('read-only'); // 修复前这里是 workspace-write
    expect(config.approval).toBe('on-request'); // 显式写的那一轴不被覆盖
    expect(warnings.join()).toMatch(/sandbox=read-only/);
  });

  it('只写了 sandbox:仍从旧值补出 approval', async () => {
    await writeGlobal({ permissionMode: 'yolo', sandbox: 'read-only' });
    const { config } = await load();
    expect(config.sandbox).toBe('read-only');
    expect(config.approval).toBe('never');
  });

  it('两个新键都写了:旧值整个忽略,但要明确告知', async () => {
    await writeGlobal({
      permissionMode: 'yolo',
      sandbox: 'read-only',
      approval: 'on-request',
    });
    const { config, warnings } = await load();
    expect(config.sandbox).toBe('read-only');
    expect(config.approval).toBe('on-request');
    expect(warnings.join()).toMatch(/was ignored/);
  });

  it('旧键不进最终配置', async () => {
    await writeGlobal({ permissionMode: 'ask' });
    const { config } = await load();
    expect((config as Record<string, unknown>).permissionMode).toBeUndefined();
  });

  it('无法识别的旧值不产生任何覆盖,也不提示', async () => {
    await writeGlobal({ permissionMode: 'plan' });
    const { config, warnings } = await load();
    expect(config.sandbox).toBe('workspace-write'); // schema 默认
    expect(config.approval).toBe('untrusted');
    expect(warnings).toEqual([]);
  });
});

describe('旧版环境变量的迁移', () => {
  const loadEnv = (env: Record<string, string>) =>
    loadRawConfig({ root, env: env as NodeJS.ProcessEnv });

  it('新变量在场时逐轴填空,不整体丢弃旧值', async () => {
    const { config } = await loadEnv({
      MOJOCODE_PERMISSION_MODE: 'readonly',
      MOJOCODE_APPROVAL: 'on-request',
    });
    expect(config.sandbox).toBe('read-only');
    expect(config.approval).toBe('on-request');
  });

  it('两个新变量都在场:旧变量忽略并提示', async () => {
    const { config, warnings } = await loadEnv({
      MOJOCODE_PERMISSION_MODE: 'yolo',
      MOJOCODE_SANDBOX: 'read-only',
      MOJOCODE_APPROVAL: 'never',
    });
    expect(config.sandbox).toBe('read-only');
    expect(warnings.join()).toMatch(/was ignored/);
  });
});
