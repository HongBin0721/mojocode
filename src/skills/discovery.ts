/**
 * 技能发现:扫描四个约定目录,按优先级去重。
 *
 * 扫描四个约定目录之外,`mojocode install` 装的包也能带技能(manifest 的
 * `skills` 段或约定的 `skills/` 目录),它们排在最后——优先级最低。
 *
 * **提示词模板**(Pi 的 prompts)也在这里扫:`~/.mojocode/prompts/`、
 * `<root>/.mojocode/prompts/`、包的 `prompts/` 目录里的每个 `*.md` 都是一条
 * 只给用户敲的 `/name` 命令——它就是一个「只有正文、目录扁平」的技能
 * (`kind: 'prompt'`,`disable-model-invocation` 恒真),菜单、参数替换、
 * 发送走的全是技能那一条路,所以不另立一套注册表。frontmatter 可省:
 * description 缺省取正文第一行。
 */

import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import {
  claudeGlobalSkillsDir,
  claudeProjectSkillsDir,
  globalPromptsDir,
  globalSkillsDir,
  projectPromptsDir,
  projectSkillsDir,
} from '../config/paths.js';
import { isValidSkillName, parseFrontmatter, parseSkillMd, type SkillMetaFields } from './parse.js';

export type SkillSource = 'project' | 'user' | 'claude-project' | 'claude-user' | 'package';

export interface SkillMeta extends SkillMetaFields {
  /** 技能目录的绝对路径(提示词模板是它所在的 prompts 目录)。 */
  dir: string;
  /** SKILL.md 的绝对路径(提示词模板是那个 `*.md`)。 */
  file: string;
  source: SkillSource;
  /** `prompt` = 提示词模板(单个 md 文件,只给用户敲);缺省是技能。 */
  kind?: 'prompt';
}

export interface SkillParseFailure {
  file: string;
  reason: string;
}

export interface SkillIndex {
  /** 按 name 排序。顺序稳定是快照变更检测的前提,不是美观问题。 */
  skills: SkillMeta[];
  failures: SkillParseFailure[];
}

/** 供命令菜单 / StateSnapshot 用的最小元数据(仅 user-invocable 技能)。 */
export interface SkillCommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
}

/** 优先级从高到低:项目 .mojocode > 全局 .mojocode > 项目 .claude > 全局 .claude > 包。 */
export function skillLocations(
  root: string,
  packageDirs: readonly string[] = [],
): Array<{ dir: string; source: SkillSource }> {
  return [
    { dir: projectSkillsDir(root), source: 'project' },
    { dir: globalSkillsDir(), source: 'user' },
    { dir: claudeProjectSkillsDir(root), source: 'claude-project' },
    { dir: claudeGlobalSkillsDir(), source: 'claude-user' },
    ...packageDirs.map((dir) => ({ dir, source: 'package' as const })),
  ];
}

/** 提示词模板目录,优先级从高到低:项目 > 全局 > 包 / 扩展贡献的。 */
export function promptLocations(
  root: string,
  packageDirs: readonly string[] = [],
): Array<{ dir: string; source: SkillSource }> {
  return [
    { dir: projectPromptsDir(root), source: 'project' },
    { dir: globalPromptsDir(), source: 'user' },
    ...packageDirs.map((dir) => ({ dir, source: 'package' as const })),
  ];
}

/**
 * 解析一个提示词模板文件。frontmatter 可有可无:`name` 缺省取文件名(去
 * `.md`),`description` 缺省取正文第一个非空行(截 80 字);`argument-hint`
 * 同技能。用户不可见的模板没有意义,所以 `user-invocable` 恒真、模型恒不可调。
 */
function parsePromptMd(
  text: string,
  fileStem: string,
): { ok: true; meta: SkillMetaFields; body: string } | { ok: false; reason: string } {
  const { fields, body } = parseFrontmatter(text);
  const rawName = typeof fields.name === 'string' ? fields.name.trim() : '';
  const name = rawName || fileStem;
  if (!isValidSkillName(name)) {
    return { ok: false, reason: `invalid prompt name "${name}" (lowercase letters, digits and hyphens only)` };
  }
  const declared = typeof fields.description === 'string' ? fields.description.trim() : '';
  const firstLine = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const description = declared || (firstLine ?? '').slice(0, 80);
  if (!description) return { ok: false, reason: 'prompt has no description and an empty body' };
  const hint = fields['argument-hint'];
  return {
    ok: true,
    meta: {
      name,
      description,
      ...(typeof hint === 'string' && hint ? { argumentHint: hint } : {}),
      disableModelInvocation: true,
      userInvocable: true,
    },
    body,
  };
}

export async function discoverSkills(
  root: string,
  packageDirs: readonly string[] = [],
  promptDirs: readonly string[] = [],
): Promise<SkillIndex> {
  const byName = new Map<string, SkillMeta>();
  const failures: SkillParseFailure[] = [];

  for (const location of skillLocations(root, packageDirs)) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(location.dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在是常态,不算失败。
    }

    for (const entry of entries) {
      // 允许符号链接指向别处的技能目录(团队共享的常见做法)。
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const dir = path.join(location.dir, entry.name);
      const file = path.join(dir, 'SKILL.md');
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue; // 没有 SKILL.md 的目录不是技能,静默跳过。
      }

      const parsed = parseSkillMd(text, entry.name);
      if (!parsed.ok) {
        failures.push({ file, reason: parsed.reason });
        continue;
      }
      // 高优先级目录先扫,同名后来者直接丢弃。
      if (byName.has(parsed.meta.name)) continue;
      byName.set(parsed.meta.name, { ...parsed.meta, dir, file, source: location.source });
    }
  }

  // 提示词模板排在技能之后:同名时技能赢(技能是更完整的东西,模板只是一段正文)。
  for (const location of promptLocations(root, promptDirs)) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(location.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.name.endsWith('.md') || entry.isDirectory()) continue;
      const file = path.join(location.dir, entry.name);
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      const parsed = parsePromptMd(text, entry.name.slice(0, -'.md'.length));
      if (!parsed.ok) {
        failures.push({ file, reason: parsed.reason });
        continue;
      }
      if (byName.has(parsed.meta.name)) continue;
      byName.set(parsed.meta.name, {
        ...parsed.meta,
        dir: location.dir,
        file,
        source: location.source,
        kind: 'prompt',
      });
    }
  }

  return {
    skills: [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    failures,
  };
}

/** 读取技能正文(不含 frontmatter)。激活/展开时现读,保证拿到磁盘上的最新版。 */
export async function readSkillBody(meta: SkillMeta): Promise<string> {
  const text = await fs.readFile(meta.file, 'utf8');
  const parsed =
    meta.kind === 'prompt'
      ? parsePromptMd(text, path.basename(meta.file, '.md'))
      : parseSkillMd(text, path.basename(meta.dir));
  if (!parsed.ok) throw new Error(`Skill "${meta.name}" failed to parse: ${parsed.reason}`);
  return parsed.body;
}

export function toCommandInfos(index: SkillIndex): SkillCommandInfo[] {
  return index.skills
    .filter((skill) => skill.userInvocable)
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
    }));
}
