import fs from 'node:fs/promises';
import {
  configSchema,
  partialConfigSchema,
  searchBackendSchema,
  type Config,
  type JsonValue,
  type PartialConfig,
  type ProviderConfig,
  type ReasoningEffort,
} from './schema.js';
import { globalConfigPath, projectConfigPath } from './paths.js';
import { PROVIDER_PRESETS, apiKeyFromEnv, isBuiltinProvider, normalizeModelId } from './providers.js';
import { resolveSearchBackend } from './search.js';

export interface LoadOptions {
  /** 工作区根目录,用于定位 `<root>/.mojocode/config.json`。 */
  root: string;
  /** 来自命令行参数的值——优先级最高。 */
  overrides?: PartialConfig;
  env?: NodeJS.ProcessEnv;
}

export class ConfigError extends Error {}

/** 单独区分出来,以便 CLI 能提供交互式的 `mojocode auth` 向导。 */
export class MissingKeyError extends ConfigError {
  constructor(
    message: string,
    readonly providerId: string,
  ) {
    super(message);
  }
}

async function readJsonIfExists(file: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
}

async function readLayer(file: string): Promise<PartialConfig> {
  const json = await readJsonIfExists(file);
  if (json === undefined) return {};
  const parsed = partialConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`${file} has invalid settings:\n${issues}`);
  }
  // zod 4 的 .partial() 不摘 .default():文件里没写的键会被幻影默认值填充
  // (provider→deepseek、timeline→full、compactThreshold→0.8……)。层合并按层优先级
  // 覆盖,于是项目层只要存在(`mojocode install --local` 就会写出一个),
  // 一个不相干的键就足以把全局保存的 provider/model、/focus 偏好在每次启动
  // 时静默重置。
  // schema.ts 只对 search/lsp/timeline 三个嵌套字段手动 extend 成裸 optional;
  // 这里按文件实际写了的键过滤解析结果,「没写」才等于「这一层不表态」——
  // 一处兜住所有带默认值的顶层字段,包括未来新增的。嵌套对象(search/lsp)
  // 的内层默认由层 schema 自己负责,不受这份过滤影响。
  const written = new Set(Object.keys(json as Record<string, unknown>));
  const layer: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (written.has(key)) layer[key] = value;
  }
  return layer as PartialConfig;
}

/** 映射到顶层配置键的环境变量。provider 的 API key 另行单独处理。 */
function envLayer(env: NodeJS.ProcessEnv): PartialConfig {
  const layer: PartialConfig = {};
  if (env.MOJOCODE_PROVIDER) layer.provider = env.MOJOCODE_PROVIDER;
  if (env.MOJOCODE_MODEL) layer.model = env.MOJOCODE_MODEL;
  if (env.MOJOCODE_GOAL_MODEL) layer.goalModel = env.MOJOCODE_GOAL_MODEL;
  if (env.MOJOCODE_TASK_MODEL) layer.taskModel = env.MOJOCODE_TASK_MODEL;
  if (env.MOJOCODE_VISION_MODEL) layer.visionModel = env.MOJOCODE_VISION_MODEL;
  // 搜索 key(MOJOCODE_SEARCH_API_KEY)不进配置层,由 resolveSearchBackend 直接读。
  if (env.MOJOCODE_SEARCH_BACKEND) {
    const parsed = searchBackendSchema.safeParse(env.MOJOCODE_SEARCH_BACKEND);
    if (parsed.success) layer.search = { backend: parsed.data };
  }
  return layer;
}

/**
 * 按键做浅合并,其中 `providers`、`mcpServers` 和 `search` 会
 * 多深入一层合并,这样项目配置可以只新增一个 MCP server 或只改搜索后端,
 * 而不会抹掉全局定义的其他条目。`lsp` 再多合并一层:`lsp.servers` 按服务器
 * id 合并,项目层只加一个 gopls 不会抹掉全局层的 pyright 覆盖。
 */
function mergeLayers(layers: PartialConfig[]): PartialConfig {
  const out: PartialConfig = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      if (key === 'lsp') {
        const prev = (out.lsp ?? {}) as Record<string, unknown>;
        const next = value as Record<string, unknown>;
        out.lsp = {
          ...prev,
          ...next,
          ...(prev.servers || next.servers
            ? {
                servers: {
                  ...(prev.servers as object | undefined),
                  ...(next.servers as object | undefined),
                },
              }
            : {}),
        } as PartialConfig['lsp'];
      } else if (key === 'packages') {
        // 装了的包取并集:项目层 `install --local` 的包不该把全局层的顶掉。
        const prev = (out.packages ?? []) as string[];
        out.packages = [...new Set([...prev, ...(value as string[])])];
      } else if (key === 'providers' || key === 'mcpServers' || key === 'search') {
        const prev = (out as Record<string, unknown>)[key];
        (out as Record<string, unknown>)[key] = {
          ...(typeof prev === 'object' && prev !== null ? prev : {}),
          ...(value as object),
        };
      } else {
        (out as Record<string, unknown>)[key] = value;
      }
    }
  }
  return out;
}

/** agent 实际对话的、完全解析后的 provider。 */
export interface ResolvedProvider {
  id: string;
  label: string;
  baseURL: string;
  /** 无凭据的本地端点(Ollama/vLLM)允许为空。 */
  apiKey: string | undefined;
  model: string;
  headers: Record<string, string>;
  contextWindow: number;
  /** 逐模型配置的最大输出 token(GUI 模型设置),未配置则交给服务端默认。 */
  maxOutputTokens?: number;
  /**
   * 逐模型自定义思考参数(GUI 模型设置):原样并入 providerOptions,完全
   * 替代 reasoningMapping 的档位翻译;存在时 /think 对该模型不生效。
   */
  reasoningParams?: Record<string, JsonValue>;
  parallelToolCalls: boolean;
  reasoningEffort: ReasoningEffort;
  sdk: 'deepseek' | 'openai-compatible';
}

export interface LoadedConfig {
  config: Config;
  provider: ResolvedProvider;
  /** 实际生效的配置文件,按优先级排序。供 `mojocode config` 使用。 */
  sources: string[];
  /** 加载期的提示,由 CLI 打给用户。 */
  warnings: string[];
}

export interface ResolveProviderOptions {
  /**
   * 探测模式(/models 枚举):缺 key、缺 model 都不抛——探测请求根本不读
   * model 字段,缺 key 就让端点用 401 给出真实答案。只有缺 baseURL 仍抛
   * (无从探测)。存在这个开关是为了让探测与实际对话共用同一份字段回退
   * 顺序:key 解析链只允许有这一份实现。
   */
  probe?: boolean;
}

/**
 * 厂商是否已被用户**显式配置**过(/models 枚举的准入判定):内置厂商 =
 * 配置文件里存过 key、或声明了自定义 apiKeyEnv 且该变量有值(与
 * resolveProvider 的 key 回退同一条链——只配 apiKeyEnv 的厂商能切过去,
 * 就必须能在选择器里被列出来);自定义条目 = 写了 baseURL(本地端点
 * 不需要凭据)。key 的有无按"存在"而不是真值判断:存过空串也是明确
 * 配置,探测会给出真实答案。紧挨 resolveProvider 而居,"对话能不能用
 * key"与"/models 里列不列出"两份判断只允许在这一份实现上同步演化。
 */
export function isProviderConfigured(
  id: string,
  override: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isBuiltinProvider(id)
    ? override.apiKey !== undefined ||
        (override.apiKeyEnv !== undefined && apiKeyFromEnv([override.apiKeyEnv], env) !== undefined)
    : override.baseURL !== undefined;
}

export function resolveProvider(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveProviderOptions = {},
): ResolvedProvider {
  const id = config.provider;
  const preset = isBuiltinProvider(id) ? PROVIDER_PRESETS[id] : undefined;
  const override: ProviderConfig = config.providers[id] ?? {};

  const baseURL = override.baseURL ?? preset?.baseURL;
  if (!baseURL) {
    throw new ConfigError(
      `Unknown provider "${id}". Either use a built-in (${Object.keys(PROVIDER_PRESETS).join(', ')}) ` +
        `or define providers.${id}.baseURL in your config.`,
    );
  }

  const apiKey =
    override.apiKey ??
    (override.apiKeyEnv ? apiKeyFromEnv([override.apiKeyEnv], env) : undefined) ??
    apiKeyFromEnv(preset?.apiKeyEnv ?? [], env);
  // 无 key 只对内置厂商(有预设)和声明了 apiKeyEnv 的自定义条目是错误——
  // 自定义本地端点(Ollama/vLLM)本来就不需要凭据,不该被拦在启动向导上。
  if (!apiKey && !options.probe && (preset !== undefined || override.apiKeyEnv !== undefined)) {
    const hint = override.apiKeyEnv ?? preset?.apiKeyEnv.join(' or ') ?? `providers.${id}.apiKey`;
    throw new MissingKeyError(
      `No API key for provider "${id}". Run \`mojocode auth\`, or set ${hint}, or providers.${id}.apiKey.`,
      id,
    );
  }

  const rawModel = config.model ?? override.model ?? preset?.defaultModel;
  // GLM 系模型名归一为大写:老配置里的小写 id 也要能对上预设的 contextWindows 键。
  const model = rawModel ? normalizeModelId(id, rawModel) : rawModel;
  if (!model && !options.probe) {
    throw new ConfigError(`No model for provider "${id}". Set providers.${id}.model or pass --model.`);
  }

  // GUI 模型设置里逐模型配置的条目:按归一后的 id 匹配。
  const modelEntry = override.models?.find((entry) => normalizeModelId(id, entry.id) === model);
  const contextWindow =
    config.maxContext ??
    // 逐模型窗口优先于 provider 级 contextWindow(后者是"整个端点一个值"的粗粒度兜底)。
    modelEntry?.contextWindow ??
    override.contextWindow ??
    preset?.contextWindows[model as keyof typeof preset.contextWindows] ??
    preset?.defaultContextWindow ??
    128_000;

  return {
    id,
    label: override.label ?? preset?.label ?? id,
    baseURL,
    apiKey,
    // probe 模式下允许缺 model(上面没抛):探测不发对话请求,空串只是占位。
    model: model ?? '',
    headers: override.headers ?? {},
    contextWindow,
    ...(modelEntry?.maxOutputTokens !== undefined ? { maxOutputTokens: modelEntry.maxOutputTokens } : {}),
    // 逐模型思考配置:对象形态 = 自定义参数原样透传;档位字符串则并入下面
    // reasoningEffort 的回退链(模型级 > provider 级 > 全局)。
    ...(typeof modelEntry?.reasoning === 'object' && modelEntry.reasoning !== null
      ? { reasoningParams: modelEntry.reasoning }
      : {}),
    parallelToolCalls: override.parallelToolCalls ?? preset?.parallelToolCalls ?? true,
    reasoningEffort:
      (typeof modelEntry?.reasoning === 'string' ? modelEntry.reasoning : undefined) ??
      override.reasoningEffort ??
      config.reasoningEffort,
    sdk: preset && 'sdk' in preset && preset.sdk === 'deepseek' ? 'deepseek' : 'openai-compatible',
  };
}

/**
 * 只做分层合并——不解析 provider,因此即使没有设置 API key 也能成功。
 * `mojocode config` 用它来展示配置,帮助用户定位如何修复缺失的 key。
 */
export async function loadRawConfig(
  options: LoadOptions,
): Promise<{ config: Config; sources: string[]; warnings: string[] }> {
  const env = options.env ?? process.env;
  const globalFile = globalConfigPath();
  const projectFile = projectConfigPath(options.root);
  const warnings: string[] = [];

  const [globalLayer, projectLayer] = await Promise.all([
    readLayer(globalFile),
    readLayer(projectFile),
  ]);

  const merged = mergeLayers([
    globalLayer,
    projectLayer,
    envLayer(env),
    options.overrides ?? {},
  ]);

  const config = configSchema.parse(merged);
  const sources: string[] = [];
  if (Object.keys(globalLayer).length > 0) sources.push(globalFile);
  if (Object.keys(projectLayer).length > 0) sources.push(projectFile);

  // 解析不出后端时 web_search 会静默不注册,不提示的话用户只会看到
  // "模型怎么不搜"。两种情形要分开说,否则提示会指向错误的修法:
  if (config.search.backend !== 'off' && !resolveSearchBackend(config, env)) {
    const hasExplicitKey = Boolean(
      config.search.apiKey ?? config.search.apiKeyEnv ?? env.MOJOCODE_SEARCH_API_KEY,
    );
    if (config.search.backend !== 'auto') {
      warnings.push(
        `search.backend is "${config.search.backend}" but no usable key/endpoint was found; ` +
          'web_search will be unavailable. Run `mojocode doctor` for details.',
      );
    } else if (hasExplicitKey) {
      // auto 刻意忽略专用 key(不知道该拿它打哪个端点),但用户配了 key 却
      // 被告知"没配 key",那是最容易卡住人的一句话。
      warnings.push(
        'A dedicated search key is set but search.backend is "auto", which only reads the ' +
          'per-backend env vars. Set search.backend to glm, exa or custom so the key is used.',
      );
    }
  }

  return { config, sources, warnings };
}

/** 分层加载:默认值 < ~/.mojocode/config.json < <root>/.mojocode/config.json < 环境变量 < 命令行参数。 */
export async function loadConfig(options: LoadOptions): Promise<LoadedConfig> {
  const { config, sources, warnings } = await loadRawConfig(options);
  return { config, provider: resolveProvider(config, options.env ?? process.env), sources, warnings };
}
