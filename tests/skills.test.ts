import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseSkillMd, parseFrontmatter, parseAllowedTools, isValidSkillName } from '../src/skills/parse.js';
import { discoverSkills, readSkillBody, toCommandInfos } from '../src/skills/discovery.js';
import { SkillManager } from '../src/skills/manager.js';
import { substituteArgs } from '../src/skills/substitute.js';
import {
  parseSlashInvocation,
  unwrapSkillPrompt,
  wrapSkillPrompt,
} from '../src/skills/invocation.js';
import { skillToolDescription } from '../src/skills/tool.js';

const SKILL = (fields: string, body = 'Do the thing.') => `---\n${fields}\n---\n\n${body}\n`;

describe('parseFrontmatter', () => {
  it('无 frontmatter 时 fields 为空、全文作正文', () => {
    const { fields, body } = parseFrontmatter('just text');
    expect(fields).toEqual({});
    expect(body).toBe('just text');
  });

  it('解析标量、引号串、行内列表与块列表', () => {
    const { fields } = parseFrontmatter(
      '---\nname: demo\ndescription: "quoted: value"\ntags: [a, b]\nallowed-tools:\n  - Read\n  - Bash(git status:*)\n---\nbody',
    );
    expect(fields.name).toBe('demo');
    expect(fields.description).toBe('quoted: value');
    expect(fields.tags).toEqual(['a', 'b']);
    expect(fields['allowed-tools']).toEqual(['Read', 'Bash(git status:*)']);
  });

  it('嵌套映射子键与注释行跳过,不污染顶层字段', () => {
    const { fields } = parseFrontmatter(
      '---\nname: demo\n# comment\nmetadata:\n  author: x\n  version: "1"\ndescription: d\n---\n',
    );
    expect(fields.name).toBe('demo');
    expect(fields.description).toBe('d');
    expect(fields.author).toBeUndefined();
  });
});

describe('parseAllowedTools', () => {
  it('空格分隔且规则含空格时按括号深度合并', () => {
    expect(parseAllowedTools('Bash(git status:*) Read Bash(npm test:*)')).toEqual([
      'Bash(git status:*)',
      'Read',
      'Bash(npm test:*)',
    ]);
  });

  it('逗号分隔与列表形式', () => {
    expect(parseAllowedTools('Read, Grep')).toEqual(['Read', 'Grep']);
    expect(parseAllowedTools(['Read', 'Grep'])).toEqual(['Read', 'Grep']);
  });

  it('空值返回 undefined', () => {
    expect(parseAllowedTools('')).toBeUndefined();
    expect(parseAllowedTools(undefined)).toBeUndefined();
    expect(parseAllowedTools([])).toBeUndefined();
  });
});

describe('parseSkillMd', () => {
  it('name 缺省回退目录名;布尔字段宽容解析;未知字段忽略', () => {
    const parsed = parseSkillMd(
      SKILL('description: does things\ndisable-model-invocation: yes\nfuture-field: whatever'),
      'my-skill',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.meta.name).toBe('my-skill');
    expect(parsed.meta.disableModelInvocation).toBe(true);
    expect(parsed.meta.userInvocable).toBe(true);
    expect(parsed.body).toBe('Do the thing.');
  });

  it('frontmatter name 与目录名不一致时拒绝', () => {
    const parsed = parseSkillMd(SKILL('name: other\ndescription: d'), 'my-skill');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain('does not match directory name');
  });

  it('description 缺失拒绝;name 非法拒绝', () => {
    expect(parseSkillMd(SKILL('name: my-skill'), 'my-skill').ok).toBe(false);
    expect(parseSkillMd(SKILL('description: d'), 'My-Skill').ok).toBe(false);
    expect(parseSkillMd(SKILL('description: d'), 'a--b').ok).toBe(false);
  });

  it('argument-hint / context: fork / allowed-tools 全解析', () => {
    const parsed = parseSkillMd(
      SKILL('description: d\nargument-hint: "[issue]"\ncontext: fork\nallowed-tools: Bash(git log:*)'),
      'demo',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.meta.argumentHint).toBe('[issue]');
    expect(parsed.meta.context).toBe('fork');
    expect(parsed.meta.allowedTools).toEqual(['Bash(git log:*)']);
  });
});

describe('isValidSkillName', () => {
  it('合法与非法样例', () => {
    expect(isValidSkillName('pdf-processing')).toBe(true);
    expect(isValidSkillName('a1')).toBe(true);
    expect(isValidSkillName('-a')).toBe(false);
    expect(isValidSkillName('a-')).toBe(false);
    expect(isValidSkillName('a--b')).toBe(false);
    expect(isValidSkillName('A')).toBe(false);
    expect(isValidSkillName('x'.repeat(65))).toBe(false);
  });
});

describe('substituteArgs', () => {
  it('$ARGUMENTS 换整串,$N 换分词,越界原样保留', () => {
    expect(substituteArgs('all: $ARGUMENTS, first: $0, third: $2', 'foo bar')).toBe(
      'all: foo bar, first: foo, third: $2',
    );
  });

  it('无占位符且有参数时追加 ARGUMENTS 行', () => {
    expect(substituteArgs('body', 'x y')).toBe('body\n\nARGUMENTS: x y');
  });

  it('无占位符且无参数时原样返回', () => {
    expect(substituteArgs('body', '')).toBe('body');
  });
});

describe('wrapSkillPrompt / unwrapSkillPrompt', () => {
  it('往返还原命令原文', () => {
    const wrapped = wrapSkillPrompt('/demo foo bar', 'the body');
    expect(unwrapSkillPrompt(wrapped)).toBe('/demo foo bar');
    expect(wrapped.endsWith('the body')).toBe(true);
  });

  it('非信封文本返回 undefined(老会话兼容)', () => {
    expect(unwrapSkillPrompt('plain message')).toBeUndefined();
    expect(unwrapSkillPrompt('<skill-command>not-a-slash</skill-command>\n\nx')).toBeUndefined();
    expect(unwrapSkillPrompt('<skill-command>/demo')).toBeUndefined();
  });
});

describe('parseSlashInvocation', () => {
  it('切出 name 与 args', () => {
    expect(parseSlashInvocation('/demo foo  bar')).toEqual({ name: 'demo', args: 'foo bar' });
    expect(parseSlashInvocation('/demo')).toEqual({ name: 'demo', args: '' });
    expect(parseSlashInvocation('not slash')).toBeUndefined();
    expect(parseSlashInvocation('/')).toBeUndefined();
  });
});

describe('discoverSkills(临时 HOME)', () => {
  let home: string;
  let root: string;

  const write = async (dir: string, name: string, content: string) => {
    await fs.mkdir(path.join(dir, name), { recursive: true });
    await fs.writeFile(path.join(dir, name, 'SKILL.md'), content);
  };

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-skill-home-'));
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-skill-root-'));
    // paths.ts 是 HOME 优先解析,mock 才能在 Bun 下也生效。
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  it('四个目录按优先级去重;解析失败进 failures', async () => {
    await write(path.join(root, '.mojocode', 'skills'), 'dupe', SKILL('description: from project'));
    await write(path.join(home, '.mojocode', 'skills'), 'dupe', SKILL('description: from user'));
    await write(path.join(home, '.mojocode', 'skills'), 'global-only', SKILL('description: g'));
    await write(path.join(root, '.claude', 'skills'), 'claude-proj', SKILL('description: cp'));
    await write(path.join(home, '.claude', 'skills'), 'claude-user', SKILL('description: cu'));
    await write(path.join(root, '.mojocode', 'skills'), 'broken', SKILL('argument-hint: x'));

    const index = await discoverSkills(root);
    expect(index.skills.map((s) => s.name)).toEqual([
      'claude-proj',
      'claude-user',
      'dupe',
      'global-only',
    ]);
    const dupe = index.skills.find((s) => s.name === 'dupe')!;
    expect(dupe.description).toBe('from project');
    expect(dupe.source).toBe('project');
    expect(index.failures).toHaveLength(1);
    expect(index.failures[0]!.file).toContain('broken');
  });

  it('目录不存在不算失败;无 SKILL.md 的子目录跳过', async () => {
    await fs.mkdir(path.join(root, '.mojocode', 'skills', 'empty-dir'), { recursive: true });
    const index = await discoverSkills(root);
    expect(index.skills).toEqual([]);
    expect(index.failures).toEqual([]);
  });

  it('readSkillBody 现读磁盘;toCommandInfos 只投影 user-invocable', async () => {
    await write(
      path.join(root, '.mojocode', 'skills'),
      'vis',
      SKILL('description: visible\nargument-hint: "[x]"'),
    );
    await write(
      path.join(root, '.mojocode', 'skills'),
      'hidden',
      SKILL('description: h\nuser-invocable: false'),
    );
    const index = await discoverSkills(root);
    expect(toCommandInfos(index)).toEqual([
      { name: 'vis', description: 'visible', argumentHint: '[x]' },
    ]);
    const vis = index.skills.find((s) => s.name === 'vis')!;
    expect(await readSkillBody(vis)).toBe('Do the thing.');
  });

  it('SkillManager:TTL 缓存、refresh 强制重扫、变更通知', async () => {
    const manager = new SkillManager({ root, ttlMs: 60_000 });
    const events: number[] = [];
    manager.subscribe(() => events.push(events.length));

    expect(manager.current().skills).toEqual([]);
    await manager.list();
    expect(events).toHaveLength(0); // 空 → 空,无实质变化。

    await write(path.join(root, '.mojocode', 'skills'), 'late', SKILL('description: late'));
    await manager.list(); // TTL 内:复用缓存,看不到新技能。
    expect(manager.find('late')).toBeUndefined();

    await manager.refresh();
    expect(manager.find('late')?.description).toBe('late');
    expect(events).toHaveLength(1);
    expect(manager.commandInfos()).toEqual([{ name: 'late', description: 'late' }]);
    expect(manager.digest()).toContain('late');
  });

  it('skillToolDescription 只列 model-invocable', async () => {
    await write(path.join(root, '.mojocode', 'skills'), 'auto', SKILL('description: auto skill'));
    await write(
      path.join(root, '.mojocode', 'skills'),
      'manual',
      SKILL('description: m\ndisable-model-invocation: true'),
    );
    const index = await discoverSkills(root);
    const desc = skillToolDescription(index);
    expect(desc).toContain('- auto: auto skill');
    expect(desc).not.toContain('manual');
  });
});
