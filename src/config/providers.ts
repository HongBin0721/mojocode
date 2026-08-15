/**
 * 内置 provider 预设的唯一权威来源。
 *
 * 三个平台的模型 ID 都变得很快(DeepSeek 用 v4 系列取代了 `deepseek-chat`,
 * GLM 已到 5.x,Kimi 已到 K2.6/K3)。所以这里的 `defaultModel` 只是一个起点——
 * 它始终可以在配置中覆盖,而且 `mojocode models --provider <id>` 会请求线上的
 * `/models` 端点,让用户看到自己的 key 实际能访问哪些模型。
 */

export interface ProviderPreset {
  /** UI 中展示的可读名称。 */
  label: string;
  /**
   * 包含版本路径在内的完整 base URL。注意:我们从不自行追加 `/v1`——
   * GLM 的服务路径是 `/api/paas/v4/chat/completions`,多加一个 `/v1`
   * 会得到 404。这里写什么就原样用什么。
   */
  baseURL: string;
  /** 按顺序检查以获取 API key 的环境变量。 */
  apiKeyEnv: string[];
  /** 用户创建 key 的控制台页面——由 `mojocode auth` 展示。 */
  keyUrl: string;
  defaultModel: string;
  /** 已知的上下文窗口大小,用于 ctx 用量显示和压缩阈值。 */
  contextWindows: Record<string, number>;
  /** 模型不在 `contextWindows` 中时的兜底值。 */
  defaultContextWindow: number;
  /** 有些端点无法处理并行工具调用;可按 provider 关闭。 */
  parallelToolCalls: boolean;
  /** 使用专用的 @ai-sdk/deepseek 包,而不是 openai-compatible。 */
  sdk?: 'deepseek';
}

export const PROVIDER_PRESETS = {
  kimi: {
    label: 'Kimi (Moonshot 国内)',
    baseURL: 'https://api.moonshot.cn/v1',
    apiKeyEnv: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    defaultModel: 'kimi-k2.6',
    contextWindows: {
      'kimi-k3': 1_000_000,
      'kimi-k2.6': 256_000,
      'kimi-k2.5': 256_000,
      'moonshot-v1-128k': 128_000,
      'moonshot-v1-32k': 32_000,
      'moonshot-v1-8k': 8_000,
    },
    defaultContextWindow: 128_000,
    parallelToolCalls: true,
  },
  /**
   * Kimi Code 订阅（包月会员）与开放平台是两套产品：sk-kimi- 前缀的密钥只在
   * api.kimi.com 域名下有效，与 api.moonshot.cn 的按量付费密钥互不通用。
   * OpenAI 兼容端点是 /coding/v1；/coding/ 是给 Claude Code 的 Anthropic 兼容端点。
   */
  'kimi-coding': {
    label: 'Kimi Code (订阅)',
    baseURL: 'https://api.kimi.com/coding/v1',
    apiKeyEnv: ['KIMI_CODE_API_KEY'],
    keyUrl: 'https://www.kimi.com/code',
    defaultModel: 'kimi-k3',
    contextWindows: {
      'kimi-k3': 1_000_000,
      'kimi-k2.6': 256_000,
    },
    defaultContextWindow: 256_000,
    parallelToolCalls: true,
  },
  'kimi-intl': {
    label: 'Kimi (Moonshot 国际)',
    baseURL: 'https://api.moonshot.ai/v1',
    apiKeyEnv: ['MOONSHOT_API_KEY_INTL', 'MOONSHOT_API_KEY'],
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    defaultModel: 'kimi-k2.6',
    contextWindows: {
      'kimi-k3': 1_000_000,
      'kimi-k2.6': 256_000,
    },
    defaultContextWindow: 128_000,
    parallelToolCalls: true,
  },
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    apiKeyEnv: ['DEEPSEEK_API_KEY'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    defaultModel: 'deepseek-v4-flash',
    contextWindows: {
      'deepseek-v4-flash': 1_000_000,
      'deepseek-v4-pro': 1_000_000,
      // 旧版别名,保留下来让老配置仍能报告合理的窗口大小。
      'deepseek-chat': 128_000,
      'deepseek-reasoner': 128_000,
    },
    defaultContextWindow: 128_000,
    parallelToolCalls: true,
    sdk: 'deepseek',
  },
  glm: {
    label: 'GLM (智谱 开放平台)',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: ['ZHIPU_API_KEY', 'ZHIPUAI_API_KEY', 'GLM_API_KEY'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    defaultModel: 'GLM-5.3',
    contextWindows: {
      'GLM-5.3': 1_000_000,
      'GLM-5.2': 1_000_000,
    },
    defaultContextWindow: 128_000,
    parallelToolCalls: true,
  },
  'glm-coding': {
    label: 'GLM (智谱 Coding Plan)',
    baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
    apiKeyEnv: ['ZHIPU_API_KEY', 'GLM_API_KEY'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    defaultModel: 'GLM-5.3',
    contextWindows: {
      'GLM-5.3': 1_000_000,
      'GLM-5.2': 1_000_000,
    },
    defaultContextWindow: 128_000,
    parallelToolCalls: true,
  },
  'glm-intl': {
    label: 'GLM (Z.ai 国际)',
    baseURL: 'https://api.z.ai/api/paas/v4',
    apiKeyEnv: ['ZAI_API_KEY', 'ZHIPU_API_KEY'],
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    defaultModel: 'GLM-5.3',
    contextWindows: {
      'GLM-5.3': 1_000_000,
      'GLM-5.2': 1_000_000,
    },
    defaultContextWindow: 128_000,
    parallelToolCalls: true,
  },
} as const satisfies Record<string, ProviderPreset>;

export type BuiltinProviderId = keyof typeof PROVIDER_PRESETS;

export const BUILTIN_PROVIDER_IDS = Object.keys(PROVIDER_PRESETS) as BuiltinProviderId[];

export function isBuiltinProvider(id: string): id is BuiltinProviderId {
  return id in PROVIDER_PRESETS;
}

/**
 * GLM 系厂商的模型名官方拼写是大写(GLM-5.3),但线上 /models 返回的以及
 * 老配置里存的是小写 id。统一归一为大写,否则大小写错位会让预设
 * contextWindows 查不到(退回兜底窗口)、ensurePresetDefault 的精确匹配合并
 * 出现重复行。厂商判断沿用 reasoning.ts 的家族前缀惯例(glm / glm-coding /
 * glm-intl)。
 */
export function normalizeModelId(providerId: string, modelId: string): string {
  return providerId.startsWith('glm') ? modelId.toUpperCase() : modelId;
}

/** 读取预设中列出的第一个非空环境变量。 */
export function apiKeyFromEnv(
  envNames: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of envNames) {
    const value = env[name];
    if (value && value.trim().length > 0) return value.trim();
  }
  return undefined;
}
