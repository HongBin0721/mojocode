import { describe, expect, it } from 'vitest';
import { listModels, listProviderModels } from '../src/model/registry.js';
import { configSchema } from '../src/config/schema.js';

/** 按 URL 前缀路由的假 fetch:未命中的 URL 一律 404(等价于探到陌生端点)。 */
function routedFetch(routes: Record<string, { status?: number; ids?: string[] }>): typeof fetch {
  return (async (input) => {
    const target = String(input);
    for (const [prefix, route] of Object.entries(routes)) {
      if (!target.includes(prefix)) continue;
      if (route.status && route.status !== 200) return new Response('boom', { status: route.status });
      return new Response(
        JSON.stringify({ data: (route.ids ?? []).map((id) => ({ id })) }),
        { status: 200 },
      );
    }
    return new Response('unexpected ' + target, { status: 404 });
  }) as typeof fetch;
}

describe('listProviderModels', () => {
  it('当前厂商排第一组;已配置的内置厂商(文件 key)按序探测并返回上下文窗口', async () => {
    const config = configSchema.parse({
      provider: 'kimi',
      providers: {
        kimi: { apiKey: 'file-key' },
        glm: { apiKey: 'glm-key' },
      },
    });
    const groups = await listProviderModels(config, {
      env: {},
      fetchImpl: routedFetch({
        'api.moonshot.cn': { ids: ['kimi-k3', 'kimi-k2.6'] },
        'open.bigmodel.cn': { ids: ['glm-5.3'] },
      }),
    });
    expect(groups.map((g) => g.providerId)).toEqual(['kimi', 'glm']);
    expect(groups[0]?.label).toBe('Kimi (Moonshot 国内)');
    // probeModels 会按 id 排序,顺序不代表端点返回顺序。
    expect(groups[0]?.models.map((m) => m.id)).toEqual(['kimi-k2.6', 'kimi-k3']);
    // 内置预设携带已知上下文窗口(UI 换算行尾标注)。
    expect(groups[0]?.contextWindows?.['kimi-k3']).toBe(1_000_000);
    expect(groups[1]?.models.map((m) => m.id)).toEqual(['glm-5.3']);
    expect(groups[1]?.error).toBeUndefined();
  });

  it('内置厂商的 key 只存在于 env 时也算已配置', async () => {
    const config = configSchema.parse({ provider: 'deepseek', providers: {} });
    const groups = await listProviderModels(config, {
      env: { DEEPSEEK_API_KEY: 'env-key' },
      fetchImpl: routedFetch({ 'api.deepseek.com': { ids: ['deepseek-v4-pro'] } }),
    });
    expect(groups.map((g) => g.providerId)).toEqual(['deepseek']);
    // 线上列表没回默认模型 deepseek-v4-flash——并入后保证可选。
    expect(groups[0]?.models.map((m) => m.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
  });

  it('线上列表滞后时并入预设默认模型(GLM Coding Plan 选不到 glm-5.3 的场景)', async () => {
    const config = configSchema.parse({
      provider: 'glm-coding',
      providers: { 'glm-coding': { apiKey: 'k' } },
    });
    // 端点只回到 glm-5.2(实测 Coding Plan 上线初期如此)。
    const groups = await listProviderModels(config, {
      env: {},
      fetchImpl: routedFetch({ 'open.bigmodel.cn': { ids: ['glm-4.6', 'glm-5.2'] } }),
    });
    const group = groups[0]!;
    expect(group.models.map((m) => m.id)).toEqual(['glm-4.6', 'glm-5.2', 'glm-5.3']);
    // 并入的默认模型仍带预设的上下文窗口标注。
    expect(group.contextWindows?.['glm-5.3']).toBe(1_000_000);
    expect(group.error).toBeUndefined();
  });

  it('listModels(CLI/向导共用)同样并入默认模型;自定义厂商不并', async () => {
    const builtin: Parameters<typeof listModels>[0] = {
      id: 'glm-coding',
      label: 'GLM',
      baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiKey: 'k',
      model: 'glm-5.2',
      headers: {},
      contextWindow: 128_000,
      parallelToolCalls: true,
      reasoningEffort: 'auto',
      sdk: 'openai-compatible',
    };
    const merged = await listModels(builtin, {
      fetchImpl: routedFetch({ 'open.bigmodel.cn': { ids: ['glm-5.2'] } }),
    });
    expect(merged.map((m) => m.id)).toEqual(['glm-5.2', 'glm-5.3']);

    const custom: Parameters<typeof listModels>[0] = {
      ...builtin,
      id: 'local',
      baseURL: 'http://127.0.0.1:11434/v1',
    };
    const untouched = await listModels(custom, {
      fetchImpl: routedFetch({ '127.0.0.1': { ids: ['qwen3'] } }),
    });
    expect(untouched.map((m) => m.id)).toEqual(['qwen3']);
  });

  it('内置厂商只配 apiKeyEnv(自定义变量名)时也进选择器', async () => {
    const config = configSchema.parse({
      provider: 'kimi',
      providers: { kimi: { apiKey: 'k' }, glm: { apiKeyEnv: 'MY_GLM_KEY' } },
    });
    const groups = await listProviderModels(config, {
      env: { MY_GLM_KEY: 'glm-key' },
      fetchImpl: routedFetch({
        'api.moonshot.cn': { ids: ['kimi-k3'] },
        'open.bigmodel.cn': { ids: ['glm-5.3'] },
      }),
    });
    // resolveProvider 支持 providers.glm.apiKeyEnv 指自定义变量,能切过去
    // 的厂商就必须能被列出来。
    expect(groups.map((g) => g.providerId)).toEqual(['kimi', 'glm']);
    expect(groups[1]?.models.map((m) => m.id)).toEqual(['glm-5.3']);
  });

  it('共享 env 变量扫进的兄弟厂商被判 401 时整组丢弃', async () => {
    // 只有 Coding Plan 的 key,按惯例导出为 ZHIPU_API_KEY:glm / glm-intl
    // 是共享变量顺带命中的兄弟,端点会拒;glm-coding 才是它真正属于的组。
    const config = configSchema.parse({ provider: 'kimi', providers: { kimi: { apiKey: 'k' } } });
    const groups = await listProviderModels(config, {
      env: { ZHIPU_API_KEY: 'coding-plan-key' },
      fetchImpl: routedFetch({
        'api.moonshot.cn': { ids: ['kimi-k3'] },
        'open.bigmodel.cn/api/coding': { ids: ['glm-5.3'] },
        'open.bigmodel.cn/api/paas': { status: 401 },
        'api.z.ai': { status: 401 },
      }),
    });
    // 被拒的兄弟组不渲染预设兜底行——那是"可选却必 401"的陷阱。
    expect(groups.map((g) => g.providerId)).toEqual(['kimi', 'glm-coding']);
  });

  it('显式配置的厂商 401 时保留预设兜底与原因(区别于兄弟组的丢弃)', async () => {
    const config = configSchema.parse({ provider: 'glm', providers: { glm: { apiKey: 'bad' } } });
    const groups = await listProviderModels(config, {
      env: {},
      fetchImpl: routedFetch({ 'open.bigmodel.cn': { status: 401 } }),
    });
    expect(groups[0]?.providerId).toBe('glm');
    expect(groups[0]?.error).toContain('401');
    expect(groups[0]?.models.length).toBeGreaterThan(0);
  });

  it('单个探测有兜底超时:黑洞端点不拖垮整个列表', async () => {
    const config = configSchema.parse({
      provider: 'kimi',
      providers: { kimi: { apiKey: 'k' }, dead: { baseURL: 'http://10.255.255.1/v1' } },
    });
    // dead 端点的 fetch 永不返回,只响应 abort(真实黑洞 TCP 的形态)。
    const hangingFetch = ((input: unknown, init?: RequestInit) => {
      if (String(input).includes('api.moonshot.cn')) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ id: 'kimi-k3' }] }), { status: 200 }),
        );
      }
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('operation timed out')));
      });
    }) as typeof fetch;
    const groups = await listProviderModels(config, {
      env: {},
      timeoutMs: 30,
      fetchImpl: hangingFetch,
    });
    expect(groups[0]?.models.map((m) => m.id)).toEqual(['kimi-k2.6', 'kimi-k3']);
    expect(groups[1]?.providerId).toBe('dead');
    expect(groups[1]?.error).toContain('timed out');
  });

  it('未配置 key 的内置厂商不进结果', async () => {
    const config = configSchema.parse({ provider: 'kimi', providers: { kimi: { apiKey: 'k' } } });
    const groups = await listProviderModels(config, {
      env: {},
      fetchImpl: routedFetch({}),
    });
    expect(groups).toHaveLength(1);
  });

  it('自定义条目(有 baseURL,无 key)同样探测', async () => {
    const config = configSchema.parse({
      provider: 'kimi',
      providers: {
        kimi: { apiKey: 'k' },
        local: { baseURL: 'http://localhost:11434/v1', label: 'Ollama' },
      },
    });
    const groups = await listProviderModels(config, {
      env: {},
      fetchImpl: routedFetch({
        'api.moonshot.cn': { ids: ['kimi-k3'] },
        'localhost:11434': { ids: ['llama3.3', 'qwen3'] },
      }),
    });
    expect(groups.map((g) => g.providerId)).toEqual(['kimi', 'local']);
    expect(groups[1]?.label).toBe('Ollama');
    expect(groups[1]?.contextWindows).toBeUndefined();
  });

  it('探测失败:组带回原因,内置预设退回已知模型', async () => {
    const config = configSchema.parse({
      provider: 'glm',
      providers: { glm: { apiKey: 'k' } },
    });
    const groups = await listProviderModels(config, {
      env: {},
      fetchImpl: routedFetch({ 'open.bigmodel.cn': { status: 500 } }),
    });
    const group = groups[0]!;
    expect(group.error).toContain('500');
    expect(group.models.length).toBeGreaterThan(0);
    expect(group.models[0]?.id).toBe('glm-5.3');
  });

  it('探测失败且无预设兜底(自定义端点)时 models 为空、原因仍在', async () => {
    const config = configSchema.parse({
      provider: 'kimi',
      providers: {
        kimi: { apiKey: 'k' },
        local: { baseURL: 'http://localhost:11434/v1' },
      },
    });
    const groups = await listProviderModels(config, {
      env: {},
      // 只路由 kimi:local 命中未注册前缀 → 404,带 error、无兜底模型。
      fetchImpl: routedFetch({ 'api.moonshot.cn': { ids: ['kimi-k3'] } }),
    });
    expect(groups[1]?.providerId).toBe('local');
    expect(groups[1]?.models).toEqual([]);
    expect(groups[1]?.error).toContain('404');
  });

  it('解析不出的条目(没有 baseURL)被跳过,不炸整批', async () => {
    const config = configSchema.parse({
      provider: 'kimi',
      providers: {
        kimi: { apiKey: 'k' },
        ghost: { apiKey: 'x' },
      },
    });
    const groups = await listProviderModels(config, {
      env: {},
      fetchImpl: routedFetch({ 'api.moonshot.cn': { ids: ['kimi-k3'] } }),
    });
    expect(groups.map((g) => g.providerId)).toEqual(['kimi']);
  });
});
