import { describe, expect, it } from 'vitest';
import {
  configSchema,
  fromLegacyMode,
  isDangerousPermissions,
  nextCycleStep,
  planReturnFor,
  presetById,
  type Permissions,
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
    expect(config.sandbox).toBe('workspace-write');
    expect(config.approval).toBe('untrusted');
    expect(config.maxSteps).toBe(50);
    expect(config.compactThreshold).toBe(0.8);
    expect(config.permissions.allowBash).toEqual([]);
  });

  it('rejects an invalid sandbox or approval value', () => {
    expect(() => makeConfig({ sandbox: 'whatever' })).toThrow();
    expect(() => makeConfig({ approval: 'whenever' })).toThrow();
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

describe('两轴权限的规则', () => {
  // 危险 ≠ 不留存:full-access 一样落盘,但选中它的路径必须留下警告。
  it('只有 full-access 算危险档位', () => {
    expect(isDangerousPermissions(presetById('full-access'))).toBe(true);
    for (const id of ['read-only', 'ask', 'auto'] as const) {
      expect(isDangerousPermissions(presetById(id))).toBe(false);
    }
    // 自由组合同理:只看 sandbox 轴。
    expect(isDangerousPermissions({ sandbox: 'danger-full-access', approval: 'untrusted' })).toBe(
      true,
    );
  });

  it('方案获批后忠实还原进入计划模式之前的组合', () => {
    for (const id of ['read-only', 'ask', 'auto', 'full-access'] as const) {
      expect(planReturnFor(presetById(id))).toEqual({ perms: presetById(id), promoted: false });
    }
  });

  // read-only+never 批准不了任何写入,"批准"就没有意义了——提升到 ask,
  // 且标记 promoted:这次提升只在本会话有效,不写进会话记录(见 bootstrap)。
  it('read-only+never 获批后提升到 ask,并标记为提升', () => {
    expect(planReturnFor({ sandbox: 'read-only', approval: 'never' })).toEqual({
      perms: presetById('ask'),
      promoted: true,
    });
  });

  it('旧单轴模式的一次性映射', () => {
    expect(fromLegacyMode('readonly')).toEqual({ sandbox: 'read-only', approval: 'never' });
    expect(fromLegacyMode('ask')).toEqual(presetById('ask'));
    expect(fromLegacyMode('acceptEdits')).toEqual(presetById('auto'));
    expect(fromLegacyMode('yolo')).toEqual(presetById('full-access'));
    // plan 从来不落盘,落了也不该复活;未知值同样丢弃。
    expect(fromLegacyMode('plan')).toBeUndefined();
    expect(fromLegacyMode('whatever')).toBeUndefined();
  });
});

describe('shift+tab 的档位循环', () => {
  it('按放宽递增走完四个预设,再经 plan 回到最紧的一档', () => {
    expect(nextCycleStep(presetById('read-only'), false)).toEqual({ preset: 'ask' });
    expect(nextCycleStep(presetById('ask'), false)).toEqual({ preset: 'auto' });
    expect(nextCycleStep(presetById('auto'), false)).toEqual({ preset: 'full-access' });
    expect(nextCycleStep(presetById('full-access'), false)).toEqual({ plan: true });
    expect(nextCycleStep(presetById('auto'), true)).toEqual({ preset: 'read-only' });
  });

  // 自由组合不在循环里,落到 plan:它写不了任何东西,误触只会收紧权限。
  it('循环外的自由组合落到 plan', () => {
    expect(nextCycleStep({ sandbox: 'read-only', approval: 'never' }, false)).toEqual({
      plan: true,
    });
    expect(nextCycleStep({ sandbox: 'workspace-write', approval: 'never' }, false)).toEqual({
      plan: true,
    });
  });

  it('连按能走遍全部五档,不会卡在某一档上', () => {
    let perms: Permissions = presetById('read-only');
    let plan = false;
    const seen = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const step = nextCycleStep(perms, plan);
      if ('plan' in step) {
        plan = true;
        seen.add('plan');
      } else {
        perms = presetById(step.preset);
        plan = false;
        seen.add(step.preset);
      }
    }
    expect(seen).toEqual(new Set(['read-only', 'ask', 'auto', 'full-access', 'plan']));
  });
});

/**
 * 放弃计划模式(未批准)绝不能拿到批准才配得上的提升。
 *
 * bootstrap 的 setPlan(false) 原样传回当前两轴而不是 planReturn.perms——
 * 后者从 read-only+never 进来时已经是被提升过的 ask。这里锁住那条前提:
 * 进入计划模式不改动两轴,所以"当前值"始终等于"进入前的值"。
 */
describe('计划模式的两轴不变性', () => {
  it('planReturnFor 只在批准语境下提升,且提升会被标记', () => {
    const strict: Permissions = { sandbox: 'read-only', approval: 'never' };
    const result = planReturnFor(strict);
    expect(result.promoted).toBe(true);
    expect(result.perms).toEqual(presetById('ask'));
    // 原组合本身没有被就地改动——放弃时要还原成它。
    expect(strict).toEqual({ sandbox: 'read-only', approval: 'never' });
  });
});
