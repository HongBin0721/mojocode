import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { fuzzyFilter, listWorkspaceFiles } from '../src/app/file-index.js';

describe('fuzzyFilter', () => {
  const paths = [
    'src/ui/Input.tsx',
    'src/ui/App.tsx',
    'src/agent/loop.ts',
    'tests/input.test.tsx',
    'README.md',
  ];

  it('空查询按原顺序返回前 limit 条', () => {
    expect(fuzzyFilter('', paths, 2)).toEqual(['src/ui/Input.tsx', 'src/ui/App.tsx']);
  });

  it('子序列匹配,大小写不敏感', () => {
    expect(fuzzyFilter('readme', paths)).toEqual(['README.md']);
  });

  it('不匹配的路径被过滤掉', () => {
    expect(fuzzyFilter('zzz', paths)).toEqual([]);
  });

  it('basename 命中优先于仅路径命中', () => {
    // "input" 是 tests/input.test.tsx 与 src/ui/Input.tsx 的 basename 前缀,
    // 而 App.tsx 只在目录部分零散命中,不该排在前面。
    const result = fuzzyFilter('input', paths);
    expect(result.slice(0, 2).sort()).toEqual(['src/ui/Input.tsx', 'tests/input.test.tsx'].sort());
  });

  it('连续命中比零散命中得分高', () => {
    const result = fuzzyFilter('loop', ['src/agent/loop.ts', 'src/lo/o/p.ts']);
    expect(result[0]).toBe('src/agent/loop.ts');
  });

  it('limit 生效', () => {
    expect(fuzzyFilter('s', paths, 1)).toHaveLength(1);
  });
});

describe('listWorkspaceFiles', () => {
  let gitRoot: string;
  let plainRoot: string;

  beforeAll(async () => {
    // git 仓库:.gitignore 生效,忽略 ignored.txt。
    gitRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-fidx-git-'));
    await execa('git', ['init', '-q'], { cwd: gitRoot });
    await fs.writeFile(path.join(gitRoot, '.gitignore'), 'ignored.txt\n');
    await fs.writeFile(path.join(gitRoot, 'kept.txt'), 'a');
    await fs.writeFile(path.join(gitRoot, 'ignored.txt'), 'b');
    await fs.mkdir(path.join(gitRoot, 'node_modules/pkg'), { recursive: true });
    await fs.writeFile(path.join(gitRoot, 'node_modules/pkg/index.js'), 'c');

    // 非 git 目录:回退 fast-glob + DEFAULT_IGNORE。
    plainRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-fidx-plain-'));
    await fs.writeFile(path.join(plainRoot, 'a.txt'), 'a');
    await fs.mkdir(path.join(plainRoot, 'node_modules/pkg'), { recursive: true });
    await fs.writeFile(path.join(plainRoot, 'node_modules/pkg/index.js'), 'c');
  });

  afterAll(async () => {
    await fs.rm(gitRoot, { recursive: true, force: true });
    await fs.rm(plainRoot, { recursive: true, force: true });
  });

  it('git 仓库里尊重 .gitignore 并过滤 DEFAULT_IGNORE', async () => {
    const files = await listWorkspaceFiles(gitRoot);
    expect(files).toContain('kept.txt');
    expect(files).not.toContain('ignored.txt');
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
  });

  it('非 git 目录回退 fast-glob,同样排除 node_modules', async () => {
    const files = await listWorkspaceFiles(plainRoot);
    expect(files).toContain('a.txt');
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
  });

  // git 默认 core.quotePath=true 会把中文路径转义成 "src/\346\210\252…",
  // 补全菜单显示转义串,插进消息后 @引用 一律解析不到文件。
  it('中文等非 ASCII 文件名不被 git 转义', async () => {
    await fs.writeFile(path.join(gitRoot, '截图.png'), 'x');
    const files = await listWorkspaceFiles(gitRoot);
    expect(files).toContain('截图.png');
    expect(files.some((f) => f.includes('\\3'))).toBe(false);
  });

  it('limit 截断结果', async () => {
    const files = await listWorkspaceFiles(gitRoot, 1);
    expect(files).toHaveLength(1);
  });
});
