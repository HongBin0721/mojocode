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
  /** Workspace root, used to find `<root>/.kdg/config.json`. */
  root: string;
  /** Values from command-line flags — highest precedence. */
  overrides?: PartialConfig;
  env?: NodeJS.ProcessEnv;
}

export class ConfigError extends Error {}

/** Distinguished so the CLI can offer the interactive `kdg auth` wizard. */
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

/** Env vars that map onto top-level config keys. Provider API keys are handled separately. */
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
 * Shallow merge per key, with `providers`, `permissions` and `mcpServers` merged
 * one level deeper so a project config can add a single MCP server without
 * wiping the ones defined globally.
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

/** The fully resolved provider the agent will talk to. */
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
  /** Files that actually contributed, in precedence order. For `kdg config`. */
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
 * Layered merge only — no provider resolution, so this succeeds even when no
 * API key is set. `kdg config` uses it to show the config that would fix that.
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

/** Layered load: defaults < ~/.kdg/config.json < <root>/.kdg/config.json < env < flags. */
export async function loadConfig(options: LoadOptions): Promise<LoadedConfig> {
  const { config, sources } = await loadRawConfig(options);
  return { config, provider: resolveProvider(config, options.env ?? process.env), sources };
}
