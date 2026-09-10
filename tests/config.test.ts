import { describe, expect, it } from 'vitest';
import {
  configSchema,
} from '../src/config/schema.js';
import { ConfigError, resolveProvider } from '../src/config/load.js';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return configSchema.parse(overrides);
}

describe('resolveProvider', () => {
  it('fills in the preset baseURL, model and context window', () => {
    const provider = resolveProvider(makeConfig({ provider: 'glm' }), { ZHIPU_API_KEY: 'k' });
    expect(provider.baseURL).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(provider.model).toBe('GLM-5.3');
    expect(provider.contextWindow).toBe(1_000_000);
  });

  it('never appends /v1 to the GLM base URL', () => {
    const provider = resolveProvider(makeConfig({ provider: 'glm' }), { ZHIPU_API_KEY: 'k' });
    expect(provider.baseURL.endsWith('/v1')).toBe(false);
  });

  it('routes DeepSeek through its dedicated SDK', () => {
    const provider = resolveProvider(makeConfig({ provider: 'deepseek' }), { DEEPSEEK_API_KEY: 'k' });
    expect(provider.sdk).toBe('deepseek');
    const glm = resolveProvider(makeConfig({ provider: 'glm' }), { ZHIPU_API_KEY: 'k' });
    expect(glm.sdk).toBe('openai-compatible');
  });

  it('tries every env var the preset lists', () => {
    expect(resolveProvider(makeConfig({ provider: 'kimi' }), { KIMI_API_KEY: 'k' }).apiKey).toBe('k');
    expect(resolveProvider(makeConfig({ provider: 'kimi' }), { MOONSHOT_API_KEY: 'm' }).apiKey).toBe('m');
  });

  it('lets top-level model win over the provider default', () => {
    const provider = resolveProvider(makeConfig({ provider: 'glm', model: 'GLM-5.2' }), {
      ZHIPU_API_KEY: 'k',
    });
    expect(provider.model).toBe('GLM-5.2');
    expect(provider.contextWindow).toBe(1_000_000);
  });

  it('normalizes legacy lowercase GLM model ids to the uppercase spelling', () => {
    // 老配置/线上列表里的小写 id 归一为大写,才能对上预设的 contextWindows 键。
    const provider = resolveProvider(makeConfig({ provider: 'glm', model: 'glm-5.3' }), {
      ZHIPU_API_KEY: 'k',
    });
    expect(provider.model).toBe('GLM-5.3');
    expect(provider.contextWindow).toBe(1_000_000);
  });

  it('falls back to the provider default window for unknown models', () => {
    const provider = resolveProvider(makeConfig({ provider: 'glm', model: 'GLM-99-future' }), {
      ZHIPU_API_KEY: 'k',
    });
    expect(provider.contextWindow).toBe(128_000);
  });

  it('GUI 配置的逐模型 contextWindow 优先于 provider 级与预设窗口', () => {
    const config = makeConfig({
      provider: 'glm',
      model: 'glm-5.2',
      providers: {
        glm: {
          contextWindow: 64_000,
          // 小写 id 也要能命中:匹配走 normalizeModelId,与解析出的 model 同一拼写。
          models: [{ id: 'glm-5.2', contextWindow: 200_000 }],
        },
      },
    });
    const provider = resolveProvider(config, { ZHIPU_API_KEY: 'k' });
    expect(provider.model).toBe('GLM-5.2');
    expect(provider.contextWindow).toBe(200_000);
    // 列表里没有的模型回落到 provider 级 contextWindow。
    const other = resolveProvider(
      makeConfig({
        provider: 'glm',
        model: 'GLM-99-future',
        providers: { glm: { contextWindow: 64_000, models: [{ id: 'GLM-5.2', contextWindow: 200_000 }] } },
      }),
      { ZHIPU_API_KEY: 'k' },
    );
    expect(other.contextWindow).toBe(64_000);
  });

  it('逐模型 maxOutputTokens 只在命中条目时解析(未配置为 undefined)', () => {
    const config = makeConfig({
      provider: 'glm',
      model: 'glm-5.2',
      providers: {
        glm: { models: [{ id: 'glm-5.2', contextWindow: 200_000, maxOutputTokens: 8192 }] },
      },
    });
    expect(resolveProvider(config, { ZHIPU_API_KEY: 'k' }).maxOutputTokens).toBe(8192);
    const other = resolveProvider(
      makeConfig({
        provider: 'glm',
        model: 'GLM-99-future',
        providers: { glm: { models: [{ id: 'glm-5.2', maxOutputTokens: 8192 }] } },
      }),
      { ZHIPU_API_KEY: 'k' },
    );
    expect(other.maxOutputTokens).toBeUndefined();
  });

  it('逐模型 reasoning:档位字符串盖过 provider 级与全局,自定义对象落到 reasoningParams', () => {
    // 档位字符串:模型级 > provider 级 reasoningEffort。
    const effortConfig = makeConfig({
      provider: 'glm',
      model: 'glm-5.2',
      providers: {
        glm: {
          reasoningEffort: 'low',
          models: [{ id: 'glm-5.2', reasoning: 'high' }],
        },
      },
    });
    const withEffort = resolveProvider(effortConfig, { ZHIPU_API_KEY: 'k' });
    expect(withEffort.reasoningEffort).toBe('high');
    expect(withEffort.reasoningParams).toBeUndefined();

    // 自定义对象:原样落到 reasoningParams,reasoningEffort 保持回退链的值。
    const customConfig = makeConfig({
      provider: 'glm',
      model: 'glm-5.2',
      providers: {
        glm: {
          reasoningEffort: 'low',
          models: [{ id: 'glm-5.2', reasoning: { thinking: { type: 'enabled' }, budget: 4096 } }],
        },
      },
    });
    const withCustom = resolveProvider(customConfig, { ZHIPU_API_KEY: 'k' });
    expect(withCustom.reasoningParams).toEqual({ thinking: { type: 'enabled' }, budget: 4096 });
    expect(withCustom.reasoningEffort).toBe('low');

    // 列表里没命中的模型:不带 reasoningParams,回退 provider 级档位。
    const other = resolveProvider(
      makeConfig({
        provider: 'glm',
        model: 'GLM-99-future',
        providers: { glm: { reasoningEffort: 'low', models: [{ id: 'glm-5.2', reasoning: 'high' }] } },
      }),
      { ZHIPU_API_KEY: 'k' },
    );
    expect(other.reasoningEffort).toBe('low');
    expect(other.reasoningParams).toBeUndefined();
  });

  it('lets maxContext override everything, for testing compaction', () => {
    const provider = resolveProvider(makeConfig({ provider: 'glm', maxContext: 8000 }), {
      ZHIPU_API_KEY: 'k',
    });
    expect(provider.contextWindow).toBe(8000);
  });

  it('supports a fully custom provider defined in config', () => {
    const provider = resolveProvider(
      makeConfig({
        provider: 'local',
        providers: { local: { baseURL: 'http://localhost:11434/v1', apiKey: 'x', model: 'qwen' } },
      }),
    );
    expect(provider.baseURL).toBe('http://localhost:11434/v1');
    expect(provider.model).toBe('qwen');
  });

  it('allows a keyless custom provider (local endpoints)', () => {
    const provider = resolveProvider(
      makeConfig({
        provider: 'custom-ollama',
        providers: { 'custom-ollama': { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen3' } },
      }),
    );
    expect(provider.apiKey).toBeUndefined();
    expect(provider.baseURL).toBe('http://127.0.0.1:11434/v1');
  });

  it('still requires a key when a custom provider declares apiKeyEnv', () => {
    expect(() =>
      resolveProvider(
        makeConfig({
          provider: 'myproxy',
          providers: { myproxy: { baseURL: 'https://proxy.example/v1', apiKeyEnv: 'MYPROXY_KEY' } },
        }),
        {},
      ),
    ).toThrow(/MYPROXY_KEY/);
  });

  it('explains what to set when the key is missing', () => {
    expect(() => resolveProvider(makeConfig({ provider: 'deepseek' }), {})).toThrow(ConfigError);
    expect(() => resolveProvider(makeConfig({ provider: 'deepseek' }), {})).toThrow(
      /DEEPSEEK_API_KEY/,
    );
  });

  it('rejects an unknown provider with the list of built-ins', () => {
    expect(() => resolveProvider(makeConfig({ provider: 'nope' }), {})).toThrow(/deepseek/);
  });
});

describe('configSchema', () => {
  it('applies sensible defaults', () => {
    const config = makeConfig();
    expect(config.maxSteps).toBeUndefined();
    expect(config.compactThreshold).toBe(0.8);
  });

  it('statusBar 宽容解析:退役的段(mode)静默丢弃,整份配置不报错', () => {
    const config = makeConfig({ statusBar: ['mode', 'model', 'context'] });
    expect(config.statusBar).toEqual(['model', 'context']);
  });

  it('rejects an invalid reasoning effort', () => {
    expect(() => makeConfig({ reasoningEffort: 'ultra' })).toThrow();
    expect(() => makeConfig({ providers: { glm: { reasoningEffort: 'ultra' } } })).toThrow();
  });
});

describe('思考强度解析', () => {
  it('defaults to auto', () => {
    expect(makeConfig().reasoningEffort).toBe('auto');
    const provider = resolveProvider(makeConfig({ provider: 'glm' }), { ZHIPU_API_KEY: 'k' });
    expect(provider.reasoningEffort).toBe('auto');
  });

  it('provider override wins over the top-level default', () => {
    const config = makeConfig({
      provider: 'glm',
      reasoningEffort: 'low',
      providers: { glm: { reasoningEffort: 'high' } },
    });
    expect(resolveProvider(config, { ZHIPU_API_KEY: 'k' }).reasoningEffort).toBe('high');
  });

  it('falls back to the top-level value when the provider has no override', () => {
    const config = makeConfig({ provider: 'glm', reasoningEffort: 'low' });
    expect(resolveProvider(config, { ZHIPU_API_KEY: 'k' }).reasoningEffort).toBe('low');
  });
});
