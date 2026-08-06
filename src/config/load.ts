import fs from 'node:fs/promises';
import {
  approvalPolicySchema,
  configSchema,
  fromLegacyMode,
  partialConfigSchema,
  sandboxModeSchema,
  searchBackendSchema,
  type Config,
  type PartialConfig,
  type ProviderConfig,
  type ReasoningEffort,
} from './schema.js';
import { globalConfigPath, projectConfigPath } from './paths.js';
import { PROVIDER_PRESETS, apiKeyFromEnv, isBuiltinProvider } from './providers.js';
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

/**
 * 旧版单轴 `permissionMode` 的一次性转换:映射到两轴,除非同一层已经写了
 * 新键(新键优先)。转换只在内存里发生,不改写用户文件——`/approvals` 落盘
 * 时才顺带清理旧键。产生一条提示,由 CLI 打给用户。
 */
function convertLegacyMode(
  json: Record<string, unknown>,
  origin: string,
  warnings: string[],
): void {
  const legacy = json.permissionMode;
  delete json.permissionMode;
  if (typeof legacy !== 'string') return;
  const mapped = fromLegacyMode(legacy);
  if (!mapped) return;

  // 逐轴填空,而不是"两个新键都缺才整体映射"。后者会在同一层混写新旧键时
  // 静默放宽:`{permissionMode:"readonly", approval:"on-request"}` 里的
  // readonly 被整个丢弃,sandbox 落回默认的 workspace-write——用户要的是只读,
  // 拿到的却是可写沙箱,而且一声不吭。
  const filled: string[] = [];
  if (json.sandbox === undefined) {
    json.sandbox = mapped.sandbox;
    filled.push(`sandbox=${mapped.sandbox}`);
  }
  if (json.approval === undefined) {
    json.approval = mapped.approval;
    filled.push(`approval=${mapped.approval}`);
  }

  warnings.push(
    filled.length > 0
      ? `${origin}: permissionMode "${legacy}" is the old single-axis setting; ` +
          `interpreted as ${filled.join(', ')}. ` +
          'Update the file to the new keys (the next /approvals change rewrites it for you).'
      : `${origin}: permissionMode "${legacy}" was ignored — sandbox and approval are both set ` +
          'explicitly and take precedence. Remove the stale permissionMode key.',
  );
}

async function readLayer(file: string, warnings: string[]): Promise<PartialConfig> {
  const json = await readJsonIfExists(file);
  if (json === undefined) return {};
  if (typeof json === 'object' && json !== null) {
    convertLegacyMode(json as Record<string, unknown>, file, warnings);
  }
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
function envLayer(env: NodeJS.ProcessEnv, warnings: string[]): PartialConfig {
  const layer: PartialConfig = {};
  if (env.MOJOCODE_PROVIDER) layer.provider = env.MOJOCODE_PROVIDER;
  if (env.MOJOCODE_MODEL) layer.model = env.MOJOCODE_MODEL;
  if (env.MOJOCODE_GOAL_MODEL) layer.goalModel = env.MOJOCODE_GOAL_MODEL;
  if (env.MOJOCODE_SANDBOX) {
    const parsed = sandboxModeSchema.safeParse(env.MOJOCODE_SANDBOX);
    if (parsed.success) layer.sandbox = parsed.data;
  }
  if (env.MOJOCODE_APPROVAL) {
    const parsed = approvalPolicySchema.safeParse(env.MOJOCODE_APPROVAL);
    if (parsed.success) layer.approval = parsed.data;
  }
  // 搜索 key(MOJOCODE_SEARCH_API_KEY)不进配置层,由 resolveSearchBackend 直接读。
  if (env.MOJOCODE_SEARCH_BACKEND) {
    const parsed = searchBackendSchema.safeParse(env.MOJOCODE_SEARCH_BACKEND);
    if (parsed.success) layer.search = { backend: parsed.data };
  }
  // 旧环境变量:逐轴填空(理由同 convertLegacyMode——整体映射会静默放宽)。
  if (env.MOJOCODE_PERMISSION_MODE) {
    const mapped = fromLegacyMode(env.MOJOCODE_PERMISSION_MODE);
    if (mapped) {
      const filled: string[] = [];
      if (layer.sandbox === undefined) {
        layer.sandbox = mapped.sandbox;
        filled.push(`sandbox=${mapped.sandbox}`);
      }
      if (layer.approval === undefined) {
        layer.approval = mapped.approval;
        filled.push(`approval=${mapped.approval}`);
      }
      warnings.push(
        filled.length > 0
          ? `MOJOCODE_PERMISSION_MODE is the old single-axis setting; ` +
              `interpreted as ${filled.join(', ')}. Switch to MOJOCODE_SANDBOX / MOJOCODE_APPROVAL.`
          : 'MOJOCODE_PERMISSION_MODE was ignored — MOJOCODE_SANDBOX and MOJOCODE_APPROVAL ' +
              'are both set and take precedence. Unset the stale variable.',
      );
    }
  }
  return layer;
}

/**
 * 按键做浅合并,其中 `providers`、`permissions`、`mcpServers` 和 `search` 会
 * 多深入一层合并,这样项目配置可以只新增一个 MCP server 或只改搜索后端,
 * 而不会抹掉全局定义的其他条目。
 */
function mergeLayers(layers: PartialConfig[]): PartialConfig {
  const out: PartialConfig = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      if (key === 'providers' || key === 'mcpServers' || key === 'permissions' || key === 'search') {
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
  reasoningEffort: ReasoningEffort;
  sdk: 'deepseek' | 'openai-compatible';
}

export interface LoadedConfig {
  config: Config;
  provider: ResolvedProvider;
  /** 实际生效的配置文件,按优先级排序。供 `mojocode config` 使用。 */
  sources: string[];
  /** 加载期的提示(如旧版 permissionMode 的一次性转换),由 CLI 打给用户。 */
  warnings: string[];
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
      `No API key for provider "${id}". Run \`mojocode auth\`, or set ${hint}, or providers.${id}.apiKey.`,
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
    reasoningEffort: override.reasoningEffort ?? config.reasoningEffort,
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
    readLayer(globalFile, warnings),
    readLayer(projectFile, warnings),
  ]);

  const merged = mergeLayers([
    globalLayer,
    projectLayer,
    envLayer(env, warnings),
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
