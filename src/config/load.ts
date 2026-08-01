import fs from 'node:fs/promises';
import {
  configSchema,
  partialConfigSchema,
  type Config,
  type PartialConfig,
  type ProviderConfig,
} from './schema.js';
import { globalConfigPath, projectConfigPath } from './paths.js';
import { PROVIDER_PRESETS, apiKeyFromEnv, isBuiltinProvider } from './providers.js';

export interface LoadOptions {
  /** 工作区根目录,用于定位 `<root>/.kdg/config.json`。 */
  root: string;
  /** 来自命令行参数的值——优先级最高。 */
  overrides?: PartialConfig;
  env?: NodeJS.ProcessEnv;
}

export class ConfigError extends Error {}

/** 单独区分出来,以便 CLI 能提供交互式的 `kdg auth` 向导。 */
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
  return parsed.data as PartialConfig;
}

/** 映射到顶层配置键的环境变量。provider 的 API key 另行单独处理。 */
function envLayer(env: NodeJS.ProcessEnv): PartialConfig {
  const layer: PartialConfig = {};
  if (env.KDG_PROVIDER) layer.provider = env.KDG_PROVIDER;
  if (env.KDG_MODEL) layer.model = env.KDG_MODEL;
  if (env.KDG_PERMISSION_MODE) {
    const parsed = configSchema.shape.permissionMode.safeParse(env.KDG_PERMISSION_MODE);
    if (parsed.success) layer.permissionMode = parsed.data;
  }
  return layer;
}

/**
 * 按键做浅合并,其中 `providers`、`permissions` 和 `mcpServers` 会多深入
 * 一层合并,这样项目配置可以只新增一个 MCP server,而不会抹掉全局定义的
 * 其他条目。
 */
function mergeLayers(layers: PartialConfig[]): PartialConfig {
  const out: PartialConfig = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      if (key === 'providers' || key === 'mcpServers' || key === 'permissions') {
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
  apiKey: string;
  model: string;
  headers: Record<string, string>;
  contextWindow: number;
  parallelToolCalls: boolean;
  sdk: 'deepseek' | 'openai-compatible';
}

export interface LoadedConfig {
  config: Config;
  provider: ResolvedProvider;
  /** 实际生效的配置文件,按优先级排序。供 `kdg config` 使用。 */
  sources: string[];
}

export function resolveProvider(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
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
  if (!apiKey) {
    const hint = override.apiKeyEnv ?? preset?.apiKeyEnv.join(' or ') ?? `providers.${id}.apiKey`;
    throw new MissingKeyError(
      `No API key for provider "${id}". Run \`kdg auth\`, or set ${hint}, or providers.${id}.apiKey.`,
      id,
    );
  }

  const model = config.model ?? override.model ?? preset?.defaultModel;
  if (!model) {
    throw new ConfigError(`No model for provider "${id}". Set providers.${id}.model or pass --model.`);
  }

  const contextWindow =
    config.maxContext ??
    override.contextWindow ??
    preset?.contextWindows[model as keyof typeof preset.contextWindows] ??
    preset?.defaultContextWindow ??
    128_000;

  return {
    id,
    label: override.label ?? preset?.label ?? id,
    baseURL,
    apiKey,
    model,
    headers: override.headers ?? {},
    contextWindow,
    parallelToolCalls: override.parallelToolCalls ?? preset?.parallelToolCalls ?? true,
    sdk: preset && 'sdk' in preset && preset.sdk === 'deepseek' ? 'deepseek' : 'openai-compatible',
  };
}

/**
 * 只做分层合并——不解析 provider,因此即使没有设置 API key 也能成功。
 * `kdg config` 用它来展示配置,帮助用户定位如何修复缺失的 key。
 */
export async function loadRawConfig(
  options: LoadOptions,
): Promise<{ config: Config; sources: string[] }> {
  const env = options.env ?? process.env;
  const globalFile = globalConfigPath();
  const projectFile = projectConfigPath(options.root);

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

  return { config, sources };
}

/** 分层加载:默认值 < ~/.kdg/config.json < <root>/.kdg/config.json < 环境变量 < 命令行参数。 */
export async function loadConfig(options: LoadOptions): Promise<LoadedConfig> {
  const { config, sources } = await loadRawConfig(options);
  return { config, provider: resolveProvider(config, options.env ?? process.env), sources };
}
