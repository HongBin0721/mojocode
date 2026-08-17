/**
 * 设置页·模型设置的纯推导单测:providerList(左列分组)与
 * configuredModelGroups(Composer 模型选择器的配置直读数据源)。
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '@core/schema';
import { BUILTIN_PROVIDER_IDS } from '@core/providers';
import {
  configuredModelGroups,
  deriveProviderId,
  providerList,
  upsertModel,
} from '../src/renderer/utils/model-settings.js';

/** 只造用到的字段;脱敏语义:apiKey 存在但为空串 = 配过 key。 */
const makeConfig = (providers: Config['providers']): Config =>
  ({ providers }) as unknown as Config;

describe('providerList', () => {
  it('预设组列出全部内置 id;配过 key(脱敏空串)或当前激活的带 configured', () => {
    const config = makeConfig({ glm: { apiKey: '' } });
    const { presets, custom } = providerList(config, 'deepseek');
    expect(presets.map((p) => p.id)).toEqual([...BUILTIN_PROVIDER_IDS]);
    expect(presets.find((p) => p.id === 'glm')?.configured).toBe(true);
    expect(presets.find((p) => p.id === 'deepseek')?.configured).toBe(true);
    expect(presets.find((p) => p.id === 'kimi')?.configured).toBe(false);
    expect(custom).toEqual([]);
  });

  it('自定义条目单独成组且恒为 configured(本地端点无需 key)', () => {
    const config = makeConfig({
      'custom-ollama': { baseURL: 'http://127.0.0.1:11434/v1', label: 'Ollama' },
    });
    const { custom } = providerList(config, undefined);
    expect(custom).toEqual([
      { id: 'custom-ollama', label: 'Ollama', configured: true, builtin: false },
    ]);
  });

  it('config 缺失时预设组仍在(全部未配置)', () => {
    const { presets, custom } = providerList(undefined, undefined);
    expect(presets.length).toBeGreaterThan(0);
    expect(presets.every((p) => !p.configured)).toBe(true);
    expect(custom).toEqual([]);
  });
});

describe('deriveProviderId', () => {
  it('名称转小写连字符;与既有键冲突时追加序号', () => {
    expect(deriveProviderId('My LLM', undefined)).toBe('my-llm');
    expect(
      deriveProviderId('My LLM', { providers: { 'my-llm': {} } } as unknown as Config),
    ).toBe('my-llm-2');
  });

  it('内置 id 也算占用;纯非 ASCII 名称回落 custom', () => {
    expect(deriveProviderId('GLM', undefined)).toBe('glm-2');
    expect(deriveProviderId('智谱', undefined)).toBe('custom');
  });
});

describe('upsertModel', () => {
  const base = [{ id: 'a' }, { id: 'b', contextWindow: 100 }];

  it("'new' 追加;同 id 先去重(重复添加是覆盖不是双份)", () => {
    expect(upsertModel(base, 'new', { id: 'c' })).toEqual([...base, { id: 'c' }]);
    expect(upsertModel(base, 'new', { id: 'a', contextWindow: 5 })).toEqual([
      { id: 'b', contextWindow: 100 },
      { id: 'a', contextWindow: 5 },
    ]);
  });

  it('数字下标按位替换;编辑改 id 撞既有条目时不去重(声明过的决定)', () => {
    expect(upsertModel(base, 1, { id: 'b2' })).toEqual([{ id: 'a' }, { id: 'b2' }]);
    expect(upsertModel(base, 1, { id: 'a' })).toEqual([{ id: 'a' }, { id: 'a' }]);
  });
});

describe('configuredModelGroups', () => {
  it('没有任何 models 配置时返回 undefined(选择器回落探测)', () => {
    expect(configuredModelGroups(makeConfig({}), 'glm')).toBeUndefined();
    expect(configuredModelGroups(makeConfig({ glm: { apiKey: '' } }), 'glm')).toBeUndefined();
    expect(configuredModelGroups(undefined, 'glm')).toBeUndefined();
  });

  it('按配置构建分组:逐模型 contextWindow 汇入映射,预设已知窗口兜底', () => {
    const config = makeConfig({
      glm: {
        models: [
          { id: 'GLM-5.3' },
          { id: 'GLM-5-Turbo', contextWindow: 200_000 },
        ],
      },
    });
    const groups = configuredModelGroups(config, 'glm')!;
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.providerId).toBe('glm');
    expect(group.models.map((m) => m.id)).toEqual(['GLM-5.3', 'GLM-5-Turbo']);
    // 逐模型显式值
    expect(group.contextWindows?.['GLM-5-Turbo']).toBe(200_000);
    // 预设兜底(GLM-5.3 在 PROVIDER_PRESETS.glm.contextWindows 里)
    expect(group.contextWindows?.['GLM-5.3']).toBe(1_000_000);
  });

  it('当前 provider 的分组排第一;无 models 的非激活 provider 不出现', () => {
    const config = makeConfig({
      glm: { models: [{ id: 'GLM-5.3' }] },
      'custom-x': { baseURL: 'https://x.example/v1', models: [{ id: 'x-1' }] },
      deepseek: { apiKey: '' },
    });
    const groups = configuredModelGroups(config, 'custom-x')!;
    expect(groups.map((g) => g.providerId)).toEqual(['custom-x', 'glm']);
  });

  it('激活 provider 没配列表时兜出只含当前模型的组,仍排第一', () => {
    // 别的 provider 配了列表不能把正在用的 provider 从选择器挤没。
    const config = makeConfig({
      'custom-x': { baseURL: 'https://x.example/v1', models: [{ id: 'x-1' }] },
      'glm-coding': { apiKey: '' },
    });
    const groups = configuredModelGroups(config, 'glm-coding', 'GLM-5.3')!;
    expect(groups.map((g) => g.providerId)).toEqual(['glm-coding', 'custom-x']);
    expect(groups[0]!.models).toEqual([{ id: 'GLM-5.3' }]);
    // 预设已知窗口兜底照旧生效。
    expect(groups[0]!.contextWindows?.['GLM-5.3']).toBe(1_000_000);
    // 不传当前模型(旧调用形状)不兜组,行为向后一致。
    expect(configuredModelGroups(config, 'glm-coding')!.map((g) => g.providerId)).toEqual([
      'custom-x',
    ]);
  });
});
