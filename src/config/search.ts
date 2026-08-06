import { apiKeyFromEnv } from './providers.js';
import type { Config } from './schema.js';

/**
 * web_search 后端预设的唯一权威来源,与 providers.ts 的 LLM 预设同构。
 *
 * 搜索后端与 LLM provider 刻意解耦:用户跑 DeepSeek(没有独立搜索 API)时,
 * 照样可以用 GLM 的搜索端点或 Exa。glm 预设复用 LLM 侧同名的 key 环境变量,
 * 所以用 GLM 当 LLM 的人零配置就能搜。
 *
 * 扩展点:Kimi 的"借模型搜索"($web_search builtin_function)走的是 chat
 * completions 侧信道——要对 Kimi 跑一个迷你工具循环并回显参数,与这里
 * "独立搜索端点"的模型不同,暂不实现;将来可作为第四种 backend 接入。
 */

export interface SearchPreset {
  /** UI 中展示的可读名称。 */
  label: string;
  /** 搜索端点完整 URL,原样使用,从不追加路径。 */
  endpoint: string;
  /** 按顺序检查以获取 API key 的环境变量。 */
  apiKeyEnv: readonly string[];
  /** 认证方式:GLM 用 Bearer,Exa 用 x-api-key 头。 */
  auth: 'bearer' | 'x-api-key';
  /** 用户创建 key 的控制台页面,doctor 的提示里展示。 */
  keyUrl: string;
}

export const SEARCH_PRESETS = {
  glm: {
    label: 'GLM Web Search (智谱)',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/web_search',
    // 与 LLM 预设同名:用 GLM 当 LLM 的人零配置即可搜索。
    apiKeyEnv: ['ZHIPU_API_KEY', 'ZHIPUAI_API_KEY', 'GLM_API_KEY'],
    auth: 'bearer',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  exa: {
    label: 'Exa',
    endpoint: 'https://api.exa.ai/search',
    apiKeyEnv: ['EXA_API_KEY'],
    auth: 'x-api-key',
    keyUrl: 'https://dashboard.exa.ai/api-keys',
  },
} as const satisfies Record<string, SearchPreset>;

export type BuiltinSearchBackendId = keyof typeof SEARCH_PRESETS;

/** 完全解析后的搜索后端——web_search 工具的全部依赖。 */
export interface ResolvedSearchBackend {
  id: BuiltinSearchBackendId | 'custom';
  label: string;
  endpoint: string;
  apiKey: string;
  auth: 'bearer' | 'x-api-key';
  /** GLM 的 search_engine 档位(search_std/search_pro/…),exa 不用。 */
  engine?: string;
  /** 默认返回条数(config.search.count)。 */
  count?: number;
}

/**
 * 解析搜索后端。与 resolveProvider 的关键差异:**缺 key 一律返回 undefined,
 * 绝不抛 MissingKeyError**——那会触发 auth 向导阻断启动,而搜索是可选能力,
 * 缺 key 的正确行为是 web_search 不注册(降级),由 doctor 负责解释和引导。
 */
export function resolveSearchBackend(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSearchBackend | undefined {
  const search = config.search;
  const shared = {
    ...(search.engine !== undefined ? { engine: search.engine } : {}),
    ...(search.count !== undefined ? { count: search.count } : {}),
  };

  switch (search.backend) {
    case 'off':
      return undefined;

    case 'glm':
    case 'exa': {
      const preset = SEARCH_PRESETS[search.backend];
      const apiKey = explicitKey(search, env) ?? apiKeyFromEnv(preset.apiKeyEnv, env);
      if (!apiKey) return undefined;
      return {
        id: search.backend,
        label: preset.label,
        endpoint: search.baseURL ?? preset.endpoint,
        apiKey,
        auth: preset.auth,
        ...shared,
      };
    }

    case 'custom': {
      // custom 没有预设可回落:端点和 key 都必须显式给出。
      const apiKey = explicitKey(search, env);
      if (!search.baseURL || !apiKey) return undefined;
      return {
        id: 'custom',
        label: 'Custom',
        endpoint: search.baseURL,
        apiKey,
        auth: 'bearer',
        ...shared,
      };
    }

    case 'auto': {
      // auto 只查各预设自己的环境变量链,刻意忽略 search.apiKey 与
      // MOJOCODE_SEARCH_API_KEY:一把不知道属于谁的 key,拿 Exa 的去打 GLM
      // 端点只会得到费解的 401。专用 key 必须配显式 backend(README 有说明)。
      for (const id of ['glm', 'exa'] as const) {
        const preset = SEARCH_PRESETS[id];
        const apiKey = apiKeyFromEnv(preset.apiKeyEnv, env);
        if (apiKey) {
          return { id, label: preset.label, endpoint: preset.endpoint, apiKey, auth: preset.auth, ...shared };
        }
      }
      return undefined;
    }
  }
}

/** 显式配置的 key:config 直写 > 自定义 env 名 > MOJOCODE_SEARCH_API_KEY。 */
function explicitKey(
  search: Config['search'],
  env: NodeJS.ProcessEnv,
): string | undefined {
  return (
    search.apiKey ??
    (search.apiKeyEnv ? apiKeyFromEnv([search.apiKeyEnv], env) : undefined) ??
    apiKeyFromEnv(['MOJOCODE_SEARCH_API_KEY'], env)
  );
}
