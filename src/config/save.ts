import fs from 'node:fs/promises';
import path from 'node:path';
import { globalConfigPath, projectConfigPath } from './paths.js';
import { type Permissions } from './schema.js';

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
 * 保存 `/approvals` 切换的两轴权限,写**项目级** `<root>/.mojocode/config.json`。
 *
 * 刻意不写全局配置:权限是对某个工作区的信任声明,和 allow 规则同一个边界。
 * 写进 `~/.mojocode/config.json` 会让一次临时放宽泄漏到之后每个目录的每次启动,
 * 而界面上除了状态栏一行小字没有任何提示。
 *
 * 全部档位一视同仁地落盘,full-access 也不例外:用户显式选的档位就该活到
 * 下一次启动,而不是每次重开都被静默改回去。代价是它绕过硬拒名单,所以选中
 * 那一档的路径都要在时间线上留一条警告(见 App 的 applyMode)。
 * 顺带清掉旧版单轴字段 permissionMode,完成一次性迁移。
 */
export async function savePermissions(
  root: string,
  permissions: Permissions,
  file?: string,
): Promise<string> {
  return updateProjectConfig(
    root,
    (config) => {
      config.sandbox = permissions.sandbox;
      config.approval = permissions.approval;
      delete config.permissionMode;
    },
    file,
  );
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
