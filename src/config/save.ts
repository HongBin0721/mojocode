import fs from 'node:fs/promises';
import path from 'node:path';
import { globalConfigPath } from './paths.js';

/**
 * Read-modify-write on the global config file. The file may hold API keys, so
 * it is always written with mode 0600 (chmod'd explicitly too, since
 * writeFile's mode only applies when the file is created).
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

export interface SaveApiKeyOptions {
  /** Also make this provider the default. */
  setDefault?: boolean;
  /** Override the target file — used by tests. */
  file?: string;
}

/** Sets the top-level default provider without touching stored keys. */
export async function setDefaultProvider(providerId: string, file?: string): Promise<string> {
  return updateGlobalConfig((config) => {
    config.provider = providerId;
  }, file);
}

/** Stores `providers.<id>.apiKey`, preserving whatever else the file contains. */
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
