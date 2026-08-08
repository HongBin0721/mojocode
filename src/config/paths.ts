import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'mojocode';

/**
 * 家目录。优先读 `HOME`(Windows 上退到 `USERPROFILE`),再退到 `os.homedir()`。
 *
 * 不直接用 `os.homedir()`:Bun 在启动时把家目录快照下来,运行期改 `process.env.HOME`
 * 对它无效,而 Node 的 POSIX 实现是每次读 `$HOME`。单二进制跑的是 Bun——同一份
 * 配置在两种发行方式下会落到不同路径(容器/CI 里显式设 HOME 是常规做法),
 * 测试里 mock 家目录也会静默穿透到开发者真实的 ~/.mojocode。
 */
function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/** `~/.mojocode`——全局配置、会话存储、日志。 */
export function globalDir(): string {
  return path.join(homeDir(), `.${APP_NAME}`);
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

/** `<workspace>/.mojocode`——项目级配置,如有需要可提交进仓库。 */
export function projectDir(root: string): string {
  return path.join(root, `.${APP_NAME}`);
}

export function projectConfigPath(root: string): string {
  return path.join(projectDir(root), 'config.json');
}

/** `~/.mojocode/skills`——全局技能目录。 */
export function globalSkillsDir(): string {
  return path.join(globalDir(), 'skills');
}

/** `<workspace>/.mojocode/skills`——项目技能目录。 */
export function projectSkillsDir(root: string): string {
  return path.join(projectDir(root), 'skills');
}

/**
 * `.claude/skills` 兼容目录。生态里现成的技能大多发布在这两个路径下
 * (Claude Code 的约定),读它们与 gatherEnvironment 兜底读 CLAUDE.md 同理。
 */
export function claudeGlobalSkillsDir(): string {
  return path.join(homeDir(), '.claude', 'skills');
}

export function claudeProjectSkillsDir(root: string): string {
  return path.join(root, '.claude', 'skills');
}
