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
 * 对项目配置 `<root>/.kdg/config.json` 做读取-修改-写回。不强制 0600:
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

/** 持久化 `/model` 的选择:写入当前 provider 的 `model`,顶层覆盖同样移除。 */
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

/** 保存 `/statusbar` 选择的状态栏信息段。 */
export async function saveStatusBar(segments: string[], file?: string): Promise<string> {
  return updateGlobalConfig((config) => {
    config.statusBar = segments;
  }, file);
}

/**
 * 保存 `/mode` 切换的权限模式,写**项目级** `<root>/.kdg/config.json`。
 *
 * 刻意不写全局配置:权限模式是对某个工作区的信任声明,和 allow 规则同一个
 * 边界。写进 `~/.kdg/config.json` 会让一次临时放宽泄漏到之后每个目录的每次
 * 启动,而界面上除了状态栏一行小字没有任何提示。
 *
 * `yolo` 永不落盘——它是"就这一次"的临时逃生口。返回 undefined 表示未保存,
 * 调用方据此告知用户该模式仅本次会话有效。
 */
export async function saveMode(
  root: string,
  mode: string,
  file?: string,
): Promise<string | undefined> {
  if (mode === 'yolo') return undefined;
  return updateProjectConfig(
    root,
    (config) => {
      config.permissionMode = mode;
    },
    file,
  );
}

/** 保存顶层 `language`,让 `/lang` 的选择在下次启动时生效。 */
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
