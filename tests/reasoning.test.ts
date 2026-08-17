import { describe, expect, it } from 'vitest';
import {
  effectiveEfforts,
  mergeProviderOptions,
  providerOptionsKey,
  reasoningMapping,
  supportedEfforts,
} from '../src/model/reasoning.js';
import type { ResolvedProvider } from '../src/config/load.js';
import type { ReasoningEffort } from '../src/config/schema.js';

function provider(overrides: Partial<ResolvedProvider>): ResolvedProvider {
  return {
    id: 'test',
    label: 'Test',
    baseURL: 'http://localhost',
    apiKey: 'k',
    model: 'test-model',
    headers: {},
    contextWindow: 128_000,
    parallelToolCalls: true,
    reasoningEffort: 'auto',
    sdk: 'openai-compatible',
    ...overrides,
  };
}

describe('reasoningMapping', () => {
  it('auto 不产生任何参数,保持服务端默认', () => {
    const mapping = reasoningMapping(provider({ id: 'glm' }), 'auto');
    expect(mapping).toEqual({ support: 'full' });
  });

  it('deepseek 用固定的 "deepseek" 键和规范字段,off 走 thinking 开关', () => {
    const p = provider({ id: 'deepseek', sdk: 'deepseek', model: 'deepseek-chat' });
    expect(reasoningMapping(p, 'off')).toEqual({
      support: 'full',
      providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
    });
    expect(reasoningMapping(p, 'max')).toEqual({
      support: 'full',
      providerOptions: { deepseek: { thinking: { type: 'enabled' }, reasoningEffort: 'max' } },
    });
  });

  it('deepseek 分支按 sdk 判断,即使自定义 id 也用 "deepseek" 键', () => {
    const p = provider({ id: 'my-deepseek', sdk: 'deepseek' });
    const mapping = reasoningMapping(p, 'high');
    expect(Object.keys(mapping.providerOptions!)).toEqual(['deepseek']);
  });

  it('glm 只有 thinking 开关:off 完整表达,档位只能粗粒度近似', () => {
    const p = provider({ id: 'glm', model: 'GLM-4.6' });
    expect(reasoningMapping(p, 'off')).toEqual({
      support: 'full',
      providerOptions: { glm: { thinking: { type: 'disabled' } } },
    });
    expect(reasoningMapping(p, 'high')).toEqual({
      support: 'coarse',
      providerOptions: { glm: { thinking: { type: 'enabled' } } },
    });
  });

  it('kimi-k3 系走 reasoning_effort:medium 归到 high,off 无法表达', () => {
    const p = provider({ id: 'kimi', model: 'kimi-k3' });
    expect(reasoningMapping(p, 'medium')).toEqual({
      support: 'coarse',
      providerOptions: { kimi: { reasoningEffort: 'high' } },
    });
    expect(reasoningMapping(p, 'max')).toEqual({
      support: 'full',
      providerOptions: { kimi: { reasoningEffort: 'max' } },
    });
    expect(reasoningMapping(p, 'off')).toEqual({ support: 'unsupported' });
  });

  it('旧 kimi k2.x 只有 thinking 开关', () => {
    const p = provider({ id: 'kimi', model: 'kimi-k2.6' });
    expect(reasoningMapping(p, 'off')).toEqual({
      support: 'full',
      providerOptions: { kimi: { thinking: { type: 'disabled' } } },
    });
    expect(reasoningMapping(p, 'high')).toEqual({
      support: 'coarse',
      providerOptions: { kimi: { thinking: { type: 'enabled' } } },
    });
  });

  it('自定义 provider 按 OpenAI 惯例透传 reasoning_effort,off 无通用表达', () => {
    const p = provider({ id: 'myapi', model: 'whatever' });
    expect(reasoningMapping(p, 'low')).toEqual({
      support: 'full',
      providerOptions: { myapi: { reasoningEffort: 'low' } },
    });
    expect(reasoningMapping(p, 'off')).toEqual({ support: 'unsupported' });
  });

  it('每个档位对每个内置 provider 都有确定结果(不抛异常)', () => {
    const efforts: ReasoningEffort[] = ['auto', 'off', 'low', 'medium', 'high', 'max'];
    const providers = [
      provider({ id: 'deepseek', sdk: 'deepseek' }),
      provider({ id: 'glm' }),
      provider({ id: 'kimi', model: 'kimi-k3' }),
      provider({ id: 'kimi', model: 'kimi-k2.5' }),
    ];
    for (const p of providers) {
      for (const effort of efforts) {
        expect(['full', 'coarse', 'unsupported']).toContain(reasoningMapping(p, effort).support);
      }
    }
  });
});

describe('providerOptionsKey', () => {
  it('把带连字符的 provider id 转成 SDK 期望的 camelCase,避免弃用警告打进 TUI 画面', () => {
    expect(providerOptionsKey('glm-coding')).toBe('glmCoding');
    expect(providerOptionsKey('kimi-intl')).toBe('kimiIntl');
    expect(providerOptionsKey('glm')).toBe('glm');
  });

  it('内置的连字符 provider 走 camelCase 键,家族判断仍按原 id', () => {
    expect(reasoningMapping(provider({ id: 'glm-coding', model: 'GLM-4.6' }), 'off')).toEqual({
      support: 'full',
      providerOptions: { glmCoding: { thinking: { type: 'disabled' } } },
    });
    expect(reasoningMapping(provider({ id: 'kimi-intl', model: 'kimi-k3' }), 'max')).toEqual({
      support: 'full',
      providerOptions: { kimiIntl: { reasoningEffort: 'max' } },
    });
  });
});

describe('supportedEfforts:档位与模型绑定', () => {
  it('deepseek 支持全部档位', () => {
    expect(supportedEfforts(provider({ id: 'deepseek', sdk: 'deepseek' }))).toEqual([
      'auto',
      'off',
      'low',
      'medium',
      'high',
      'max',
    ]);
  });

  it('glm-4 系只有开关:仅 auto 和 off 可选,伪档位不出现', () => {
    expect(supportedEfforts(provider({ id: 'glm', model: 'GLM-4.6' }))).toEqual(['auto', 'off']);
  });

  it('glm-5 系 reasoning_effort 是实测过的真档位:全档可选', () => {
    expect(supportedEfforts(provider({ id: 'glm-coding', model: 'GLM-5.3' }))).toEqual([
      'auto',
      'off',
      'low',
      'medium',
      'high',
      'max',
    ]);
  });

  it('kimi-k3 无法关闭思考且没有 medium', () => {
    expect(supportedEfforts(provider({ id: 'kimi', model: 'kimi-k3' }))).toEqual([
      'auto',
      'low',
      'high',
      'max',
    ]);
  });

  it('旧 kimi k2.x 只有开关', () => {
    expect(supportedEfforts(provider({ id: 'kimi', model: 'kimi-k2.5' }))).toEqual(['auto', 'off']);
  });

  it('自定义 provider 走通用透传,没有 off', () => {
    expect(supportedEfforts(provider({ id: 'myapi' }))).toEqual([
      'auto',
      'low',
      'medium',
      'high',
      'max',
    ]);
  });
});

describe('effectiveEfforts:目录 × wire 可表达性', () => {
  it('目录缺口(undefined)回退家族表——会思考的模型不能因此没了档位', () => {
    // deepseek-reasoner / kimi-for-coding 这类条目在目录里就是"会思考但没说
    // 档位形状";当成"不推理"会让思考彻底调不了。
    // 回退路径也不带 'auto':它是会话默认态,不是可点档位。
    expect(effectiveEfforts(provider({ id: 'deepseek', sdk: 'deepseek' }), undefined)).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'max',
    ]);
    expect(effectiveEfforts(provider({ id: 'glm', model: 'GLM-4.6' }), undefined)).toEqual(['off']);
  });

  it('目录明说不推理(空数组)原样返回——前端据此隐藏思考 chip', () => {
    expect(effectiveEfforts(provider({ id: 'deepseek', sdk: 'deepseek' }), [])).toEqual([]);
  });

  it('目录档位优先于家族表(家族表会过时),但剔掉 wire 发不出去的档位', () => {
    // kimi-k3 目录带 toggle → 含 off,而 reasoningMapping 对它 off 是 unsupported
    // (什么都不发、思考照旧开着),必须剔除。
    expect(
      effectiveEfforts(provider({ id: 'kimi', model: 'kimi-k3' }), ['off', 'low', 'high', 'max']),
    ).toEqual(['low', 'high', 'max']);
    // GLM-5.3 的档位如今是 full(实测 reasoning_effort 生效);GLM-4 系目录若
    // 给出档位,coarse(等于开启思考)也保留——粗粒度近似不是无效。
    expect(
      effectiveEfforts(provider({ id: 'glm-coding', model: 'GLM-5.3' }), ['low', 'high', 'max']),
    ).toEqual(['low', 'high', 'max']);
    expect(effectiveEfforts(provider({ id: 'glm', model: 'GLM-4.6' }), ['low', 'high'])).toEqual([
      'low',
      'high',
    ]);
  });
});

describe('mergeProviderOptions', () => {
  it('同一 provider 键下的选项做一层合并,不互相覆盖', () => {
    expect(
      mergeProviderOptions(
        { glm: { parallel_tool_calls: false } },
        { glm: { thinking: { type: 'disabled' } } },
      ),
    ).toEqual({ glm: { parallel_tool_calls: false, thinking: { type: 'disabled' } } });
  });

  it('全为空时返回 undefined,不给 streamText 传空对象', () => {
    expect(mergeProviderOptions(undefined, undefined)).toBeUndefined();
    expect(mergeProviderOptions()).toBeUndefined();
  });

  it('跳过 undefined 输入,保留其余', () => {
    expect(mergeProviderOptions(undefined, { kimi: { reasoningEffort: 'max' } })).toEqual({
      kimi: { reasoningEffort: 'max' },
    });
  });
});
