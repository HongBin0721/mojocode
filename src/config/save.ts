import fs from 'node:fs/promises';
import path from 'node:path';
import { globalConfigPath, projectConfigPath } from './paths.js';

/**
 * 对全局配置文件做读取-修改-写回。文件可能存有 API key,因此总是以 0600
 * 权限写入(还会显式 chmod,因为 writeFile 的 mode 只在文件新建时生效)。
 */
export async function updateGlobalConfig(
  mutate: (config: Record<string, unknown>) => void,
  file: string = globalConfigPath(),
): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  mutate(config);

  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

/**
 * 对项目配置 `<root>/.mojocode/config.json` 做读取-修改-写回。不强制 0600:
 * 这个文件按设计可以提交进仓库(权限 allow 规则也写在这里),不该被
 * 悄悄改成私有权限。
 */
export async function updateProjectConfig(
  root: string,
  mutate: (config: Record<string, unknown>) => void,
  file: string = projectConfigPath(root),
): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  mutate(config);

  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return file;
}

export interface SaveApiKeyOptions {
  /** 同时把该 provider 设为默认。 */
  setDefault?: boolean;
  /** 覆盖目标文件——测试用。 */
  file?: string;
}

/** 设置顶层默认 provider,不动已保存的 key。 */
export async function setDefaultProvider(providerId: string, file?: string): Promise<string> {
  return updateGlobalConfig((config) => {
    config.provider = providerId;
  }, file);
}

/**
 * 持久化 `/provider` 的切换:写顶层 `provider`,并移除顶层 `model` 覆盖——
 * 它属于旧 provider,保留会让新 provider 下次启动时拿到错误的模型 id
 * (与 bootstrap 中切换 provider 时丢弃内存覆盖的行为一致)。
 */
export async function saveProviderChoice(providerId: string, file?: string): Promise<string> {
  return updateGlobalConfig((config) => {
    config.provider = providerId;
    delete config.model;
  }, file);
}

/** 持久化 `/models` 的选择:写入当前 provider 的 `model`,顶层覆盖同样移除。 */
export async function saveModelChoice(
  providerId: string,
  model: string,
  file?: string,
): Promise<string> {
  return updateGlobalConfig((config) => {
    const providers =
      typeof config.providers === 'object' && config.providers !== null
        ? (config.providers as Record<string, Record<string, unknown>>)
        : {};
    providers[providerId] = { ...(providers[providerId] ?? {}), model };
    config.providers = providers;
    delete config.model;
  }, file);
}

/** 保存 `/think` 选择的思考强度到当前 provider,下次启动直接生效。 */
export async function saveReasoningEffort(
  providerId: string,
  effort: string,
  file?: string,
): Promise<string> {
  return updateGlobalConfig((config) => {
    const providers =
      typeof config.providers === 'object' && config.providers !== null
        ? (config.providers as Record<string, Record<string, unknown>>)
        : {};
    providers[providerId] = { ...(providers[providerId] ?? {}), reasoningEffort: effort };
    config.providers = providers;
  }, file);
}

/** 保存设置面板(/setting)里选择的状态栏信息段。 */
export async function saveStatusBar(segments: string[], file?: string): Promise<string> {
  return updateGlobalConfig((config) => {
    config.statusBar = segments;
  }, file);
}

/** 保存 `/focus` 选择的时间线显示密度。 */
export async function saveTimelineMode(mode: string, file?: string): Promise<string> {
  return updateGlobalConfig((config) => {
    config.timeline = mode;
  }, file);
}

/**
 * 保存 `/theme` 选择的主题名;`undefined`(内置配色)删掉 `theme` 键。
 * 写到**持有该键的那一层**:项目配置已经写了 `theme` 就改项目配置——只写
 * 全局的话项目层下次启动会把它盖回去,用户看到的是"落盘了却不生效";
 * 项目层没写就落全局(与 /focus、/think 一致)。
 *
 * 删键时**每一层都删**:schema 里没有"内置配色"的显式写法(`default` 是保留名,
 * 磁盘上没有那个文件),只删项目层会让全局层的值浮上来——下次启动仍不是内置。
 */
export async function saveTheme(name: string | undefined, root: string): Promise<string> {
  const mutate = (config: Record<string, unknown>) => {
    if (name === undefined) delete config.theme;
    else config.theme = name;
  };
  let project: unknown;
  try {
    project = JSON.parse(await fs.readFile(projectConfigPath(root), 'utf8'));
  } catch {
    // 没有项目配置、或不是合法 JSON:按"项目层没写"处理,落全局。
  }
  const projectOwnsTheme = typeof project === 'object' && project !== null && 'theme' in project;
  if (!projectOwnsTheme) return updateGlobalConfig(mutate);
  const file = await updateProjectConfig(root, mutate);
  if (name === undefined) await updateGlobalConfig(mutate);
  return file;
}

/** 保存顶层 `language`,让设置面板里选的语言在下次启动时生效。 */
export async function saveLanguage(language: string, file?: string): Promise<string> {
  return updateGlobalConfig((config) => {
    config.language = language;
  }, file);
}

/** 保存 `providers.<id>.apiKey`,保留文件中的其他内容。 */
export async function saveApiKey(
  providerId: string,
  apiKey: string,
  options: SaveApiKeyOptions = {},
): Promise<string> {
  return updateGlobalConfig((config) => {
    const providers =
      typeof config.providers === 'object' && config.providers !== null
        ? (config.providers as Record<string, Record<string, unknown>>)
        : {};
    providers[providerId] = { ...(providers[providerId] ?? {}), apiKey };
    config.providers = providers;
    if (options.setDefault) config.provider = providerId;
  }, options.file);
}

/**
 * 保存自定义(非内置)provider 的定义:baseURL 必有,apiKey 可省——本地端点
 * (Ollama/vLLM/LM Studio)不需要凭据。与 saveApiKey 一样合并写,不覆盖该 id
 * 已有的 model 等字段;重跑向导配同一个地址会自然更新同一条目。
 */
export async function saveCustomProvider(
  providerId: string,
  definition: { baseURL: string; apiKey?: string },
  file?: string,
): Promise<string> {
  return updateGlobalConfig((config) => {
    const providers =
      typeof config.providers === 'object' && config.providers !== null
        ? (config.providers as Record<string, Record<string, unknown>>)
        : {};
    const existing = providers[providerId] ?? {};
    providers[providerId] = {
      ...existing,
      baseURL: definition.baseURL,
      ...(definition.apiKey ? { apiKey: definition.apiKey } : {}),
    };
    config.providers = providers;
  }, file);
}
