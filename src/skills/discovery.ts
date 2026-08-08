/**
 * 技能发现:扫描四个约定目录,按优先级去重。
 *
 * 发现走裸 fs 而不经沙箱——与 gatherEnvironment 读 AGENTS.md 同理,这是
 * 宿主自己的配置读取,不是模型驱动的工具调用;模型读技能目录里的 L3 资源
 * 才走沙箱(激活时登记的只读扩根,见 bootstrap 的 activateSkill)。
 */

import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import {
  claudeGlobalSkillsDir,
  claudeProjectSkillsDir,
  globalSkillsDir,
  projectSkillsDir,
} from '../config/paths.js';
import { parseSkillMd, type SkillMetaFields } from './parse.js';

export type SkillSource = 'project' | 'user' | 'claude-project' | 'claude-user';

export interface SkillMeta extends SkillMetaFields {
  /** 技能目录的绝对路径(激活时作只读扩根)。 */
  dir: string;
  /** SKILL.md 的绝对路径。 */
  file: string;
  source: SkillSource;
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

/** 优先级从高到低:项目 .mojocode > 全局 .mojocode > 项目 .claude > 全局 .claude。 */
export function skillLocations(root: string): Array<{ dir: string; source: SkillSource }> {
  return [
    { dir: projectSkillsDir(root), source: 'project' },
    { dir: globalSkillsDir(), source: 'user' },
    { dir: claudeProjectSkillsDir(root), source: 'claude-project' },
    { dir: claudeGlobalSkillsDir(), source: 'claude-user' },
  ];
}

export async function discoverSkills(root: string): Promise<SkillIndex> {
  const byName = new Map<string, SkillMeta>();
  const failures: SkillParseFailure[] = [];

  for (const location of skillLocations(root)) {
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

  return {
    skills: [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    failures,
  };
}

/** 读取技能正文(不含 frontmatter)。激活/展开时现读,保证拿到磁盘上的最新版。 */
export async function readSkillBody(meta: SkillMeta): Promise<string> {
  const text = await fs.readFile(meta.file, 'utf8');
  const parsed = parseSkillMd(text, path.basename(meta.dir));
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
