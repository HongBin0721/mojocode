import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configSchema, partialConfigSchema } from '../src/config/schema.js';
import { loadRawConfig } from '../src/config/load.js';

describe('timeline(/focus)配置分层', () => {
  it('默认 full;非法值被拒', () => {
    expect(configSchema.parse({}).timeline).toBe('full');
    expect(() => configSchema.parse({ timeline: 'tiny' })).toThrow();
  });

  it('分层 schema 不产生幻影默认值(.partial() 不摘 .default 的回归)', () => {
    const layer = partialConfigSchema.parse({ provider: 'glm' });
    expect((layer as Record<string, unknown>).timeline).toBeUndefined();
  });

  describe('全局保存的 /focus 偏好不被项目层重置', () => {
    let home: string;
    let root: string;

    beforeEach(async () => {
      home = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-tl-home-'));
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-tl-root-'));
      process.env.HOME = home;
    });

    afterEach(async () => {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    });

    it('项目层存在但未写 timeline 时,全局层的 compact 生效', async () => {
      await fs.mkdir(path.join(home, '.mojocode'), { recursive: true });
      await fs.writeFile(
        path.join(home, '.mojocode', 'config.json'),
        JSON.stringify({ timeline: 'compact' }),
      );
      // 项目层写点别的(比如 /approvals 落过盘),不含 timeline。
      await fs.mkdir(path.join(root, '.mojocode'), { recursive: true });
      await fs.writeFile(
        path.join(root, '.mojocode', 'config.json'),
        JSON.stringify({ approval: 'on-request' }),
      );

      const { config } = await loadRawConfig({ root, env: {} });
      expect(config.timeline).toBe('compact');
    });
  });
});
