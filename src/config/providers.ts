/**
 * Single source of truth for the built-in provider presets.
 *
 * Model IDs on all three platforms churn fast (DeepSeek retired `deepseek-chat`
 * in favour of the v4 line, GLM is already on 5.x, Kimi on K2.6/K3). So the
 * `defaultModel` here is only a starting point — it is always overridable from
 * config, and `kdg models --provider <id>` hits the live `/models` endpoint so
 * users can see what their key actually has access to.
 */

export interface ProviderPreset {
  /** Human-readable name shown in the UI. */
  label: string;
  /**
   * Full base URL including any version path. NOTE: we never append `/v1`
   * ourselves — GLM serves at `/api/paas/v4/chat/completions` and an extra
   * `/v1` produces a 404. Whatever is written here is used verbatim.
   */
  baseURL: string;
  /** Env vars checked in order for the API key. */
  apiKeyEnv: string[];
  /** Console page where the user creates a key — shown by `kdg auth`. */
  keyUrl: string;
  defaultModel: string;
  /** Known context windows, used for the ctx meter and compaction threshold. */
  contextWindows: Record<string, number>;
  /** Fallback when the model isn't in `contextWindows`. */
  defaultContextWindow: number;
  /** Some endpoints choke on parallel tool calls; opt out per provider. */
  parallelToolCalls: boolean;
  /** Use the dedicated @ai-sdk/deepseek package instead of openai-compatible. */
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
      // Legacy aliases, kept so old configs still report a sane window.
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
    defaultModel: 'glm-4.6',
    contextWindows: {
      'glm-5.2': 1_000_000,
      'glm-5.1': 200_000,
      'glm-5': 200_000,
      'glm-5-turbo': 200_000,
      'glm-4.7': 200_000,
      'glm-4.7-flash': 200_000,
      'glm-4.7-flashx': 200_000,
      'glm-4.6': 200_000,
      'glm-4.5-air': 128_000,
      'glm-4.5-flash': 128_000,
      'glm-4-long': 1_000_000,
    },
    defaultContextWindow: 128_000,
    parallelToolCalls: true,
  },
  'glm-coding': {
    label: 'GLM (智谱 Coding Plan)',
    baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
    apiKeyEnv: ['ZHIPU_API_KEY', 'GLM_API_KEY'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    defaultModel: 'glm-4.6',
    contextWindows: {
      'glm-5.2': 1_000_000,
      'glm-5': 200_000,
      'glm-4.7': 200_000,
      'glm-4.6': 200_000,
    },
    defaultContextWindow: 128_000,
    parallelToolCalls: true,
  },
  'glm-intl': {
    label: 'GLM (Z.ai 国际)',
    baseURL: 'https://api.z.ai/api/paas/v4',
    apiKeyEnv: ['ZAI_API_KEY', 'ZHIPU_API_KEY'],
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    defaultModel: 'glm-4.6',
    contextWindows: {
      'glm-5': 200_000,
      'glm-4.6': 200_000,
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

/** Reads the first non-empty env var listed in the preset. */
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
