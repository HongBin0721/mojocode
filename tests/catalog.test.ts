/**
 * models.dev 能力目录测试:裁剪、查找(预设映射 + 全库回退)、档位推导、
 * 缓存生命周期(新鲜命中 / 过期重拉 / 失败回过期缓存 / 失败退避重试)。
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MODELS_DEV_URL,
  capabilitiesFor,
  catalogModel,
  createCatalogSource,
  effortChoices,
  pruneCatalog,
  type Catalog,
} from '../src/model/catalog.js';

/** 上游形状的最小样本(含形状异常条目,裁剪必须跳过而不是抛)。 */
const RAW = {
  'zhipuai-coding-plan': {
    models: {
      'glm-5.3': {
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
        limit: { context: 1_000_000, output: 131_072 },
      },
      'glm-4.7': {
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }],
        limit: { context: 204_800, output: 131_072 },
      },
    },
  },
  'moonshotai-cn': {
    models: {
      'kimi-k3': {
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
        limit: { context: 1_048_576, output: 131_072 },
      },
      'kimi-k2.7-code': { reasoning: false, reasoning_options: [], limit: { context: 262_144 } },
    },
  },
  aggregator: {
    models: {
      // 与 moonshotai-cn 同名但无思考选项:全库回退时应优先富条目。
      'kimi-k3': { reasoning: false, limit: { context: 100 } },
      'qwen3-32b': {
        reasoning: true,
        reasoning_options: [
          { type: 'effort', values: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
        ],
        limit: { context: 131_072, output: 32_768 },
      },
    },
  },
  // 会思考但目录没说档位形状:线上占多数的一类(deepseek-reasoner 等)。
  gapped: {
    models: {
      'gap-model': { reasoning: true, reasoning_options: [], limit: { context: 64_000 } },
    },
  },
  broken: { models: { bad: null, worse: 'string' } },
  empty: {},
};

const catalog = pruneCatalog(RAW);

describe('pruneCatalog', () => {
  it('只留消费字段;模型 id 小写化;异常条目跳过不抛', () => {
    expect(catalog['zhipuai-coding-plan']?.['glm-5.3']).toEqual({
      reasoning: true,
      toggle: false,
      effortValues: ['low', 'high', 'max'],
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
    });
    // broken 供应商的两个坏条目被跳过后整组为空,不出现在目录里。
    expect(catalog['broken']).toBeUndefined();
    expect(catalog['empty']).toBeUndefined();
    expect(pruneCatalog(null)).toEqual({});
    expect(pruneCatalog('garbage')).toEqual({});
  });
});

describe('catalogModel / capabilitiesFor', () => {
  it('预设 id 走映射,模型 id 大小写不敏感(GLM 大写归一后仍命中)', () => {
    expect(catalogModel(catalog, 'glm-coding', 'GLM-5.3')?.contextWindow).toBe(1_000_000);
    expect(catalogModel(catalog, 'kimi', 'kimi-k3')?.toggle).toBe(true);
  });

  it('映射外的自定义条目全库回退,同名模型优先带思考选项的条目', () => {
    const hit = catalogModel(catalog, 'my-proxy', 'kimi-k3');
    expect(hit?.toggle).toBe(true);
    expect(hit?.contextWindow).toBe(1_048_576);
    expect(catalogModel(catalog, 'my-proxy', 'qwen3-32b')?.maxOutputTokens).toBe(32_768);
    expect(catalogModel(catalog, 'my-proxy', 'ghost-model')).toBeUndefined();
  });

  it('capabilitiesFor 汇总窗口/输出/档位;查不到返回 undefined', () => {
    expect(capabilitiesFor(catalog, 'glm-coding', 'GLM-5.3')).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      efforts: ['low', 'high', 'max'],
    });
    expect(capabilitiesFor(catalog, 'glm-coding', 'nope')).toBeUndefined();
  });

  it('目录缺口时 efforts 键整个不出现(而不是空数组),窗口等其余字段照给', () => {
    const gap = capabilitiesFor(catalog, 'gapped', 'gap-model');
    expect(gap).toEqual({ contextWindow: 64_000 });
    expect('efforts' in gap!).toBe(false);
  });
});

describe('effortChoices', () => {
  it('toggle → off 可选;effort 值与枚举求交;none 归 off;枚举外值丢弃;auto 不在能力集里', () => {
    expect(effortChoices(catalog['zhipuai-coding-plan']!['glm-4.7']!)).toEqual(['off']);
    expect(effortChoices(catalog['moonshotai-cn']!['kimi-k3']!)).toEqual([
      'off',
      'low',
      'high',
      'max',
    ]);
    // none→off,minimal/xhigh 丢弃,medium 保留。
    expect(effortChoices(catalog['aggregator']!['qwen3-32b']!)).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'max',
    ]);
  });

  it('无思考能力的模型返回空数组(Composer 据此隐藏思考 chip)', () => {
    expect(effortChoices(catalog['moonshotai-cn']!['kimi-k2.7-code']!)).toEqual([]);
  });

  it('会思考但目录没说档位形状 → undefined(目录缺口,调用方回退家族表)', () => {
    // 线上目录里有 1400+ 这样的条目(deepseek-reasoner、kimi-for-coding 都是)。
    // 早先把它和"不推理"一样返回 [],这些模型的思考就彻底关不掉也调不了。
    expect(effortChoices({ reasoning: true, toggle: false, effortValues: [] })).toBeUndefined();
    // 档位值全在枚举外(minimal/xhigh)也是缺口,不是"没有档位"。
    expect(
      effortChoices({ reasoning: true, toggle: false, effortValues: ['minimal', 'xhigh'] }),
    ).toBeUndefined();
  });
});

describe('createCatalogSource', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const makeDir = async (): Promise<string> => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-catalog-'));
    return dir;
  };

  const okFetch = (calls: string[]): typeof fetch =>
    (async (input: unknown) => {
      calls.push(String(input));
      return new Response(JSON.stringify(RAW), { status: 200 });
    }) as typeof fetch;

  it('新鲜缓存直接用,不发网络请求;过期后重拉并回写缓存', async () => {
    const base = await makeDir();
    const cachePath = path.join(base, 'models-dev.json');
    let clock = 1_000_000;
    const calls: string[] = [];
    await fs.writeFile(
      cachePath,
      JSON.stringify({ fetchedAt: clock, catalog: { stale: { m: { reasoning: false, toggle: false, effortValues: [] } } } }),
    );

    const fresh = createCatalogSource({
      cachePath,
      fetchImpl: okFetch(calls),
      now: () => clock,
      ttlMs: 1000,
    });
    expect((await fresh.get())?.['stale']).toBeDefined();
    expect(calls).toEqual([]);

    // 过期:重拉(URL 正确)、结果换新、缓存回写。
    clock += 2000;
    const expired = createCatalogSource({
      cachePath,
      fetchImpl: okFetch(calls),
      now: () => clock,
      ttlMs: 1000,
    });
    const reloaded = await expired.get();
    expect(calls).toEqual([MODELS_DEV_URL]);
    expect(reloaded?.['zhipuai-coding-plan']).toBeDefined();
    const written = JSON.parse(await fs.readFile(cachePath, 'utf8')) as { fetchedAt: number; catalog: Catalog };
    expect(written.fetchedAt).toBe(clock);

    // memo:同一实例再取不再发请求。
    await expired.get();
    expect(calls.length).toBe(1);
  });

  it('回过期缓存后不永久 memo:退避窗口内继续用旧数据,窗口一过重新拉并转正', async () => {
    const base = await makeDir();
    const cachePath = path.join(base, 'models-dev.json');
    let clock = 1_000_000;
    let online = false;
    const calls: string[] = [];
    const flaky: typeof fetch = (async (input: unknown) => {
      calls.push(String(input));
      if (!online) throw new Error('offline');
      return new Response(JSON.stringify(RAW), { status: 200 });
    }) as typeof fetch;
    await fs.writeFile(
      cachePath,
      JSON.stringify({ fetchedAt: 0, catalog: { stale: { m: { reasoning: false, toggle: false, effortValues: [] } } } }),
    );

    const source = createCatalogSource({
      cachePath,
      fetchImpl: flaky,
      now: () => clock,
      ttlMs: 1000,
      retryAfterMs: 500,
    });
    // 离线:用过期缓存。
    expect((await source.get())?.['stale']).toBeDefined();
    // 退避窗口内:还是旧数据,但不再打网络。
    expect((await source.get())?.['stale']).toBeDefined();
    expect(calls.length).toBe(1);
    // 网络恢复 + 过退避窗口:重拉并换成新目录(旧版本永久 memo 会卡在 stale)。
    online = true;
    clock += 600;
    const fresh = await source.get();
    expect(calls.length).toBe(2);
    expect(fresh?.['zhipuai-coding-plan']).toBeDefined();
    expect(fresh?.['stale']).toBeUndefined();
  });

  it('网络失败回过期缓存;无缓存失败返回 undefined 并退避,过退避窗口后重试', async () => {
    const base = await makeDir();
    const cachePath = path.join(base, 'models-dev.json');
    let clock = 1_000_000;
    const failFetch: typeof fetch = async () => {
      throw new Error('offline');
    };

    // 有过期缓存:失败也能用旧数据。
    await fs.writeFile(
      cachePath,
      JSON.stringify({ fetchedAt: 0, catalog: { stale: { m: { reasoning: false, toggle: false, effortValues: [] } } } }),
    );
    const withStale = createCatalogSource({ cachePath, fetchImpl: failFetch, now: () => clock, ttlMs: 1 });
    expect((await withStale.get())?.['stale']).toBeDefined();

    // 无缓存:undefined + 退避期内不再发请求,过窗口后重试成功。
    let attempts = 0;
    const flaky: typeof fetch = (async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return new Response(JSON.stringify(RAW), { status: 200 });
    }) as typeof fetch;
    const noCache = createCatalogSource({
      cachePath: path.join(base, 'missing.json'),
      fetchImpl: flaky,
      now: () => clock,
      ttlMs: 1000,
      retryAfterMs: 500,
    });
    expect(await noCache.get()).toBeUndefined();
    expect(await noCache.get()).toBeUndefined(); // 退避期内不重试
    expect(attempts).toBe(1);
    clock += 600;
    expect((await noCache.get())?.['moonshotai-cn']).toBeDefined();
    expect(attempts).toBe(2);
  });
});
