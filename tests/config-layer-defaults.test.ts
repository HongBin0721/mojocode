import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadRawConfig } from '../src/config/load.js';
import {
  configSchema,
  lspConfigSchema,
  lspLayerSchema,
  partialConfigSchema,
  searchConfigSchema,
  searchLayerSchema,
} from '../src/config/schema.js';

/**
 * 层文件里「没写」的键不得以幻影默认值参与合并(zod 4 的 .partial() 不摘
 * .default())。回归背景:项目层只要存在(/approvals 落盘就会写它),幻影
 * provider:'deepseek' 就以更高优先级把全局保存的 /provider、/models 选择
 * 在每次启动时静默重置回默认厂商——用户看到的就是"切换模型关掉再开就丢"。
 */
describe('层文件缺省键不产生幻影默认值', () => {
  let home: string;
  let root: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-ld-home-'));
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-ld-root-'));
    process.env.HOME = home;
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeGlobal(config: Record<string, unknown>): Promise<void> {
    await fs.mkdir(path.join(home, '.mojocode'), { recursive: true });
    await fs.writeFile(path.join(home, '.mojocode', 'config.json'), JSON.stringify(config));
  }

  async function writeProject(config: Record<string, unknown>): Promise<void> {
    await fs.mkdir(path.join(root, '.mojocode'), { recursive: true });
    await fs.writeFile(path.join(root, '.mojocode', 'config.json'), JSON.stringify(config));
  }

  it('项目层存在但未写 provider 时,全局层的 provider/model 生效(核心回归)', async () => {
    await writeGlobal({
      provider: 'glm',
      providers: { glm: { apiKey: 'k', model: 'GLM-5.2' } },
    });
    // 项目层只写了权限(/approvals 落盘的真实形状),不含任何模型选择。
    await writeProject({ sandbox: 'danger-full-access', approval: 'never' });

    const { config } = await loadRawConfig({ root, env: { ZHIPU_API_KEY: 'k' } });
    expect(config.provider).toBe('glm');
    expect(config.model).toBeUndefined();
    expect(config.providers.glm?.model).toBe('GLM-5.2');
  });

  it('项目层显式写 provider 时仍然覆盖全局层', async () => {
    await writeGlobal({ provider: 'glm', providers: { glm: { apiKey: 'k' } } });
    await writeProject({ provider: 'deepseek' });

    const { config } = await loadRawConfig({ root, env: { ZHIPU_API_KEY: 'k' } });
    expect(config.provider).toBe('deepseek');
  });

  it('两层都没写 provider 时,deepseek 默认值照常生效', async () => {
    await writeGlobal({ language: 'zh-CN' });
    await writeProject({ approval: 'never' });

    const { config } = await loadRawConfig({ root, env: { DEEPSEEK_API_KEY: 'k' } });
    expect(config.provider).toBe('deepseek');
  });

  it('幻影默认不覆盖其他带默认值的标量字段(maxSteps/reasoningEffort)', async () => {
    await writeGlobal({ maxSteps: 10, reasoningEffort: 'max' });
    await writeProject({ approval: 'never' });

    const { config } = await loadRawConfig({ root, env: {} });
    expect(config.maxSteps).toBe(10);
    expect(config.reasoningEffort).toBe('max');
  });

  it('空配置文件产生空层,不携带任何幻影键', async () => {
    await writeGlobal({});
    await writeProject({});

    const { config, sources } = await loadRawConfig({ root, env: {} });
    expect(config.provider).toBe('deepseek');
    expect(sources).toEqual([]);
  });
});

/**
 * partialConfigSchema 是 configSchema 的手写镜像(见 schema.ts 的注释)。
 * 键集一旦漂移:configSchema 加了新字段而镜像漏同步,层文件里*显式*写的
 * 值会被 zod 当未知键剥掉、再被 readLayer 的 written 过滤丢弃,静默落回
 * 默认值——既不是幻影覆盖,也没有任何报错。这里用键集合断言把漏同步
 * 拦在测试期;嵌套层 schema(search/lsp)同理。
 */
describe('分层 schema 与全量 schema 保持同步(parity)', () => {
  it('顶层键集合一致:configSchema 新增字段必须同步进 partialConfigSchema', () => {
    expect(Object.keys(partialConfigSchema.shape).sort()).toEqual(
      Object.keys(configSchema.shape).sort(),
    );
  });

  it('嵌套层 schema 的键集合一致(search/lsp)', () => {
    expect(Object.keys(searchLayerSchema.shape).sort()).toEqual(
      Object.keys(searchConfigSchema.shape).sort(),
    );
    expect(Object.keys(lspLayerSchema.shape).sort()).toEqual(
      Object.keys(lspConfigSchema.shape).sort(),
    );
  });

  it('层 schema 解析空对象得到空对象——镜像字段也不许带 .default()', () => {
    // 键同步了但误带 .default() 的字段同样会注入幻影值,parse({}) 必须一无所出。
    expect(partialConfigSchema.parse({})).toEqual({});
    expect(searchLayerSchema.parse({})).toEqual({});
    expect(lspLayerSchema.parse({})).toEqual({});
  });
});
