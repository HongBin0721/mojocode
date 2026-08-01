import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'kdg';

/** `~/.kdg`——全局配置、会话存储、日志。 */
export function globalDir(): string {
  return path.join(os.homedir(), `.${APP_NAME}`);
}

export function globalConfigPath(): string {
  return path.join(globalDir(), 'config.json');
}

export function sessionsDir(): string {
  return path.join(globalDir(), 'sessions');
}

export function logPath(): string {
  return path.join(globalDir(), 'debug.log');
}

/** `<workspace>/.kdg`——项目级配置,如有需要可提交进仓库。 */
export function projectDir(root: string): string {
  return path.join(root, `.${APP_NAME}`);
}

export function projectConfigPath(root: string): string {
  return path.join(projectDir(root), 'config.json');
}
