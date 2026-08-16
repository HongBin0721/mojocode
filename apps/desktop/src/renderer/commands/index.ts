/**
 * 斜杠命令表:/ 命令菜单的数据源。内置命令(models/new/compact/review/
 * simplify)+ StateSnapshot.skills 的技能直映射(技能随 state 推送到达,
 * 无需请求)。描述文案走 GUI i18n;技能的 description 是 server 给的原文。
 */

import { t } from '../i18n/index.js';

/** StateSnapshot.skills 的最小形状(protocol.ts 的 SkillCommandInfo)。 */
export interface SkillInfo {
  name: string;
  description: string;
  argumentHint?: string;
}

export interface CommandEntry {
  /** 不带斜杠的命令名。 */
  name: string;
  /** 一行描述(已本地化;技能为原文)。 */
  description: string;
  /** 参数提示(技能可能有;内置命令 /review /simplify 也有)。 */
  argumentHint?: string;
  source: 'builtin' | 'skill';
}

export function builtinCommands(): CommandEntry[] {
  return [
    { name: 'models', description: t('slash.models'), source: 'builtin' },
    { name: 'new', description: t('slash.new'), source: 'builtin' },
    { name: 'compact', description: t('slash.compact'), source: 'builtin' },
    { name: 'review', description: t('slash.review'), argumentHint: '[scope]', source: 'builtin' },
    { name: 'simplify', description: t('slash.simplify'), argumentHint: '[target]', source: 'builtin' },
  ];
}

export function skillCommands(skills: SkillInfo[]): CommandEntry[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    argumentHint: skill.argumentHint,
    source: 'skill' as const,
  }));
}

/** 前缀过滤(大小写不敏感)。空 query 返回全表。 */
export function filterCommands(entries: CommandEntry[], query: string): CommandEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (entry) =>
      entry.name.toLowerCase().startsWith(q) || entry.description.toLowerCase().includes(q),
  );
}

/**
 * 从输入框当前文本解析菜单态:首字符为 `/` 且**尚未出现空格**时菜单激活,
 * query 为斜杠后的片段;出现空格即进入参数输入态(菜单收起)。
 */
export function slashState(text: string): { active: boolean; query: string } {
  if (!text.startsWith('/')) return { active: false, query: '' };
  const rest = text.slice(1);
  const spaceAt = rest.indexOf(' ');
  if (spaceAt !== -1) return { active: false, query: rest.slice(0, spaceAt) };
  return { active: true, query: rest };
}
