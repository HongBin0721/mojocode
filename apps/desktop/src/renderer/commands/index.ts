/**
 * 斜杠命令表:/ 命令菜单的数据源。三段拼起来,顺序即优先级:
 * 内置(models/new/compact/simplify)> 扩展(`StateSnapshot.extensions.commands`)
 * > 技能(`StateSnapshot.skills`),同名先到者赢——与 TUI 同一条规则。
 *
 * 扩展命令的描述由**会话进程**本地化后随快照过来(GUI 不再自带那批文案),
 * 执行走 `runCommand` RPC,取值走 `commandOptions`。
 */

import type { ExtensionCommandInfo } from '@core/protocol';
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
  /** 一行描述(内置为本地化文案;扩展与技能是会话进程给的原文)。 */
  description: string;
  /** 参数提示(技能可能有;内置 /simplify 与部分扩展命令也有)。 */
  argumentHint?: string;
  source: 'builtin' | 'extension' | 'skill';
  /** 扩展命令:有取值选择器,菜单上选中先进选项层而不是直接执行。 */
  hasOptions?: boolean;
  /** 扩展命令:选项层的标题。 */
  selectorTitle?: string;
}

export function builtinCommands(): CommandEntry[] {
  return [
    { name: 'models', description: t('slash.models'), source: 'builtin' },
    { name: 'new', description: t('slash.new'), source: 'builtin' },
    { name: 'compact', description: t('slash.compact'), source: 'builtin' },
    { name: 'simplify', description: t('slash.simplify'), argumentHint: '[target]', source: 'builtin' },
  ];
}

export function extensionCommands(infos: ExtensionCommandInfo[]): CommandEntry[] {
  return infos.map((info) => ({
    name: info.name,
    description: info.description,
    ...(info.argumentHint ? { argumentHint: info.argumentHint } : {}),
    source: 'extension' as const,
    ...(info.hasOptions ? { hasOptions: true } : {}),
    ...(info.selectorTitle ? { selectorTitle: info.selectorTitle } : {}),
  }));
}

export function skillCommands(skills: SkillInfo[]): CommandEntry[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    argumentHint: skill.argumentHint,
    source: 'skill' as const,
  }));
}

/** 三段合表,同名先到者赢(内置 > 扩展 > 技能)。 */
export function allCommands(
  extensions: ExtensionCommandInfo[],
  skills: SkillInfo[],
): CommandEntry[] {
  const seen = new Set<string>();
  return [
    ...builtinCommands(),
    ...extensionCommands(extensions),
    ...skillCommands(skills),
  ].filter((entry) => {
    if (seen.has(entry.name)) return false;
    seen.add(entry.name);
    return true;
  });
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
