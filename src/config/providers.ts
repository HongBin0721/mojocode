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
  /**
   * 模型 id 的官方拼写归一(如 GLM 系端点回小写、官方拼写是大写)。厂商
   * 怪癖住在它自己的预设里,而不是通用路径上的 id 前缀判断——后者会误伤
   * 名字碰巧带同样前缀的自定义条目(如 glm-proxy),改写它发往端点的 id。
   */
  normalizeModelId?: (id: string) => string;
  /**
   * 能直接接收图片输入的模型 id 表(大小写不敏感的前缀匹配,覆盖 -turbo
   * 等变体)。isVisionModel 据此判定当前模型是否走图片直发;不在表里的
   * provider 保守判非视觉——降级为文件引用是安全方向,永远不会被拒单。
   */
  visionModels?: readonly string[];
  /**
   * 该 provider 下 view_image 工具缺省使用的视觉模型 id(起点默认,顶层
   * config 的 visionModel / MOJOCODE_VISION_MODEL 可覆盖)。原样发往端点,
   * 不经 normalizeModelId——同 taskModel 的先例。
   */
  visionModel?: string;
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
    // 显式空表:deepseek 全系纯文本,且专用 SDK 会静默丢弃图片 part——
    // isVisionModel 对它乐观直发只会换来无声幻觉。
    visionModels: [],
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
    normalizeModelId: (id) => id.toUpperCase(),
    visionModels: ['glm-4.5v', 'glm-4.6v', 'glm-5v'],
    visionModel: 'glm-4.6v',
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
    normalizeModelId: (id) => id.toUpperCase(),
    visionModels: ['glm-4.5v', 'glm-4.6v', 'glm-5v'],
    visionModel: 'glm-4.6v',
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
    normalizeModelId: (id) => id.toUpperCase(),
    visionModels: ['glm-4.5v', 'glm-4.6v', 'glm-5v'],
    visionModel: 'glm-4.6v',
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
 * 把模型 id 归一为厂商预设的官方拼写(GLM 系端点回小写、官方拼写是大写,
 * 不归一会让预设 contextWindows 查不到、ensurePresetDefault 合并出重复行)。
 * 查预设表而不是按 provider id 前缀判断:自定义条目(哪怕叫 glm-proxy)
 * 不在表里,永不归一——归一后的 id 是要发往端点的,不能碰用户自己的拼写。
 */
export function normalizeModelId(providerId: string, modelId: string): string {
  // 显式标成 ProviderPreset:表是 as const 的,kimi 等未声明该字段的成员
  // 类型上没有这个可选属性,直接对联合取属性会报错。
  const preset: ProviderPreset | undefined = isBuiltinProvider(providerId)
    ? PROVIDER_PRESETS[providerId]
    : undefined;
  return preset?.normalizeModelId ? preset.normalizeModelId(modelId) : modelId;
}

/**
 * 当前模型能否直接接收图片输入。config 的 providers.<id>.vision 显式覆盖
 * 优先(两个方向都生效——把误判的视觉模型拉回直发,或把漏登的判成视觉);
 * 否则查预设的 visionModels 前缀表。匹配必须大小写不敏感:normalizeModelId
 * 会把 GLM 系 id 归一成大写(GLM-4.6V-TURBO),小写表直接 startsWith 会全漏。
 *
 * 无表的来源分两类,方向相反:**内置**厂商我们了解(deepseek/kimi 显式给
 * 空表——deepseek SDK 还会静默丢弃图片 part,判乐观就是纯幻觉),按表走,
 * 表空即非视觉;**自定义**端点一无所知,乐观返回 true 沿用旧版直发行为——
 * 降级为文件引用在解析不出 visionModel 时图就永远读不到,比一次可见的
 * 服务端报错更糟,报错至少能指引用户用 providers.<id>.vision 关掉。
 */
export function isVisionModel(providerId: string, modelId: string, override?: boolean): boolean {
  if (override !== undefined) return override;
  if (!isBuiltinProvider(providerId)) return true;
  const preset: ProviderPreset | undefined = PROVIDER_PRESETS[providerId];
  const entries = preset?.visionModels;
  if (!entries) return true;
  const id = modelId.toLowerCase();
  return entries.some((entry) => id.startsWith(entry.toLowerCase()));
}

/**
 * isVisionModel 的调用面便捷版:判定某个已解析 provider 的当前模型。
 * 结构化参数(而非 ResolvedProvider)避免与 load.ts 循环依赖。四处调用点
 * (agent 循环、TUI/headless 的 @图展开模式、doctor)共用,防止表达式漂移。
 */
export function providerModelIsVision(
  provider: { id: string; model: string },
  config: { providers?: Record<string, { vision?: boolean }> },
): boolean {
  return isVisionModel(provider.id, provider.model, config.providers?.[provider.id]?.vision);
}

/**
 * view_image 工具的视觉模型 id 解析:顶层 visionModel 覆盖,缺省回落内置
 * 预设的 visionModel。deepseek SDK 的转换器会静默丢弃图片 part(node_modules
 * 里 user-content 循环只保留 text),配了也只是幻觉描述,直接不解析。
 * 返回 undefined 表示工具不注册。
 */
export function resolveVisionModelId(
  providerId: string,
  config: { visionModel?: string },
): string | undefined {
  const preset: ProviderPreset | undefined = isBuiltinProvider(providerId)
    ? PROVIDER_PRESETS[providerId]
    : undefined;
  if (preset?.sdk === 'deepseek') return undefined;
  return config.visionModel ?? preset?.visionModel;
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
