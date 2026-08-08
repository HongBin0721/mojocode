/**
 * SKILL.md 解析(agentskills.io 标准)。
 *
 * frontmatter 手写解析而不引 YAML 依赖:项目的配置层是 JSON,沙箱的 glob
 * 也是手写的(sandbox.ts matchGlob)——技能头部只需要标量、引号串和列表,
 * 一个完整 YAML 解析器换来的只有依赖面。未知字段一律接受并忽略,这是
 * 标准的要求(宽容解析,别的实现的扩展字段不该让技能整个失效)。
 */

export interface SkillMetaFields {
  name: string;
  description: string;
  argumentHint?: string;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  allowedTools?: string[];
  context?: 'fork';
}

export type ParsedSkill =
  | { ok: true; meta: SkillMetaFields; body: string }
  | { ok: false; reason: string };

/** 标准的 name 约束:小写字母数字 + 单个连字符分隔,1-64 字符。 */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && NAME_PATTERN.test(name);
}

/**
 * 拆出 frontmatter 与正文。没有 frontmatter(首行不是 `---`)时 fields 为空,
 * 整个文本都算正文——让上层用"description 缺失"这种具体理由报错,而不是
 * 在这里就含糊地拒掉。
 */
export function parseFrontmatter(text: string): { fields: Record<string, unknown>; body: string } {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return { fields: {}, body: text };

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { fields: {}, body: text };

  const fields: Record<string, unknown> = {};
  let i = 1;
  while (i < end) {
    const line = lines[i]!;
    i += 1;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    // 只认顶层 `key: value`;缩进行(嵌套映射,如 metadata: 的子键)跳过。
    if (/^\s/.test(line)) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();

    // 块列表:`key:` 后跟若干 `- item` 行。
    if (!value) {
      const items: string[] = [];
      while (i < end) {
        const next = lines[i]!;
        const trimmed = next.trim();
        if (/^\s+-\s+/.test(next) || trimmed.startsWith('- ')) {
          items.push(unquote(trimmed.replace(/^-\s+/, '')));
          i += 1;
        } else if (!trimmed) {
          i += 1;
        } else if (/^\s/.test(next)) {
          // 嵌套映射的子键——不是列表项,整段跳过。
          i += 1;
        } else {
          break;
        }
      }
      if (items.length > 0) fields[key] = items;
      continue;
    }

    // 行内列表 `[a, b]`。
    if (value.startsWith('[') && value.endsWith(']')) {
      fields[key] = value
        .slice(1, -1)
        .split(',')
        .map((item) => unquote(item.trim()))
        .filter(Boolean);
      continue;
    }

    fields[key] = unquote(value);
  }

  const body = lines.slice(end + 1).join('\n');
  return { fields, body };
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** 布尔字段的宽容解析(Claude Code 同款字面量);不认识的值返回 undefined。 */
function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  switch (value.toLowerCase()) {
    case 'true':
    case 'yes':
    case 'on':
    case '1':
      return true;
    case 'false':
    case 'no':
    case 'off':
    case '0':
      return false;
    default:
      return undefined;
  }
}

/**
 * allowed-tools:标准写空格分隔的字符串,Claude Code 兼容逗号与 YAML 列表。
 * 规则值本身可以带空格(`Bash(git status:*)`),所以空格切分必须按括号
 * 深度合并——朴素 split 会把一条规则劈成两半,进 gate 后一半成了永远
 * 匹配不上的死规则,另一半可能意外放行别的命令。
 */
export function parseAllowedTools(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map(String).map((s) => s.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim();
  if (text.includes(',')) {
    const items = text.split(',').map((s) => s.trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  const items: string[] = [];
  let current = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (current) items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) items.push(current);
  return items.length > 0 ? items : undefined;
}

/**
 * 解析并校验一个 SKILL.md。`dirName` 是技能目录名:标准要求 name 与目录名
 * 一致,而生态里大量技能干脆省略 name(Claude Code 视其为可选)——所以
 * 缺失时回退目录名,写了但对不上目录名时以目录名为准之外直接拒绝,
 * 两个名字各指一个技能只会让 `/name` 和 skill 工具各查到一半。
 */
export function parseSkillMd(text: string, dirName: string): ParsedSkill {
  const { fields, body } = parseFrontmatter(text);

  const rawName = typeof fields.name === 'string' ? fields.name.trim() : '';
  const name = rawName || dirName;
  if (!isValidSkillName(name)) {
    return { ok: false, reason: `invalid skill name "${name}" (lowercase letters, digits and hyphens only)` };
  }
  if (rawName && rawName !== dirName) {
    return { ok: false, reason: `frontmatter name "${rawName}" does not match directory name "${dirName}"` };
  }

  const description = typeof fields.description === 'string' ? fields.description.trim() : '';
  if (!description) {
    return { ok: false, reason: 'missing required "description" in frontmatter' };
  }

  const argumentHint =
    typeof fields['argument-hint'] === 'string' && fields['argument-hint'].trim()
      ? fields['argument-hint'].trim()
      : undefined;
  const context = fields.context === 'fork' ? ('fork' as const) : undefined;

  return {
    ok: true,
    meta: {
      name,
      description,
      ...(argumentHint ? { argumentHint } : {}),
      disableModelInvocation: asBoolean(fields['disable-model-invocation']) ?? false,
      userInvocable: asBoolean(fields['user-invocable']) ?? true,
      ...(parseAllowedTools(fields['allowed-tools'])
        ? { allowedTools: parseAllowedTools(fields['allowed-tools']) }
        : {}),
      ...(context ? { context } : {}),
    },
    body: body.trim(),
  };
}
