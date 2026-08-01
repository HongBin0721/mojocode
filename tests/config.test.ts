import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/config/schema.js';
import { ConfigError, resolveProvider } from '../src/config/load.js';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return configSchema.parse(overrides);
}

describe('resolveProvider', () => {
  it('fills in the preset baseURL, model and context window', () => {
    const provider = resolveProvider(makeConfig({ provider: 'glm' }), { ZHIPU_API_KEY: 'k' });
    expect(provider.baseURL).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(provider.model).toBe('glm-4.6');
    expect(provider.contextWindow).toBe(200_000);
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
    const provider = resolveProvider(makeConfig({ provider: 'glm', model: 'glm-5' }), {
      ZHIPU_API_KEY: 'k',
    });
    expect(provider.model).toBe('glm-5');
    expect(provider.contextWindow).toBe(200_000);
  });

  it('falls back to the provider default window for unknown models', () => {
    const provider = resolveProvider(makeConfig({ provider: 'glm', model: 'glm-99-future' }), {
      ZHIPU_API_KEY: 'k',
    });
    expect(provider.contextWindow).toBe(128_000);
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
    expect(config.permissionMode).toBe('ask');
    expect(config.maxSteps).toBe(50);
    expect(config.compactThreshold).toBe(0.8);
    expect(config.permissions.allowBash).toEqual([]);
  });

  it('rejects an invalid permission mode', () => {
    expect(() => makeConfig({ permissionMode: 'whatever' })).toThrow();
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
