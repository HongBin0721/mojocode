import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  installPackage,
  nameOf,
  packageDirOf,
  parsePackageSource,
  removePackage,
  resolvePackages,
  type CommandRunner,
} from '../src/extensions/packages.js';

/**
 * `mojocode install / remove` 的机制:spec 解析、落点、外部命令的 argv、
 * 配置记录。npm / git 经注入的 runner 断言,不联网。
 */

let home: string;
let root: string;
let savedHome: string | undefined;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-pkg-home-'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-pkg-root-'));
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(async () => {
  process.env.HOME = savedHome;
  for (const dir of [home, root]) await fs.rm(dir, { recursive: true, force: true });
});

const readGlobal = async () =>
  JSON.parse(await fs.readFile(path.join(home, '.mojocode', 'config.json'), 'utf8')) as {
    packages?: string[];
  };

describe('parsePackageSource', () => {
  it('npm: 前缀带版本;scoped 包名的 @ 不当版本分隔', () => {
    expect(parsePackageSource('npm:@scope/pkg@1.2.3', '/w')).toMatchObject({ kind: 'npm', name: '@scope/pkg' });
    expect(parsePackageSource('npm:plain@^2', '/w')).toMatchObject({ kind: 'npm', name: 'plain', requested: 'plain@^2' });
  });

  it('git: 前缀与裸 URL 都算 git,名字取仓库尾段去 .git', () => {
    expect(parsePackageSource('git:https://github.com/a/b.git', '/w')).toMatchObject({ kind: 'git', name: 'b' });
    expect(parsePackageSource('git@github.com:a/c.git', '/w')).toMatchObject({ kind: 'git', name: 'c', spec: 'git:git@github.com:a/c.git' });
  });

  it('其余按路径,相对路径以 cwd 解析成绝对路径记录', () => {
    expect(parsePackageSource('./ext', '/w')).toEqual({ kind: 'path', spec: '/w/ext', dir: '/w/ext' });
    expect(nameOf(parsePackageSource('/x/y/my-ext', '/w'))).toBe('my-ext');
  });
});

describe('installPackage', () => {
  it('npm:在 <base>/npm 下建私有 package.json,跑 npm install,记进全局配置', async () => {
    const calls: Array<[string, string[], string]> = [];
    const run: CommandRunner = vi.fn(async (cmd, args, cwd) => {
      calls.push([cmd, args, cwd]);
      return { stdout: '', stderr: '' };
    });
    const result = await installPackage('npm:@scope/thing@1.0.0', { root, run });
    const npmRoot = path.join(home, '.mojocode', 'packages', 'npm');
    expect(calls).toEqual([['npm', ['install', '--no-audit', '--no-fund', '--save', '@scope/thing@1.0.0'], npmRoot]]);
    expect(JSON.parse(await fs.readFile(path.join(npmRoot, 'package.json'), 'utf8'))).toMatchObject({ private: true });
    expect(result.dir).toBe(path.join(npmRoot, 'node_modules', '@scope', 'thing'));
    expect((await readGlobal()).packages).toEqual(['npm:@scope/thing@1.0.0']);
  });

  it('git:clone 到 <base>/git/<name>;有依赖再 npm install;重复安装不重复记录', async () => {
    const calls: Array<[string, string[]]> = [];
    const run: CommandRunner = vi.fn(async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'git' && args[0] === 'clone') {
        const dir = args.at(-1)!;
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { zod: '*' } }));
      }
      return { stdout: '', stderr: '' };
    });
    const gitDir = path.join(home, '.mojocode', 'packages', 'git', 'ext');
    await installPackage('git:https://example.com/x/ext.git', { root, run });
    expect(calls[0]).toEqual(['git', ['clone', '--depth', '1', 'https://example.com/x/ext.git', gitDir]]);
    expect(calls[1]).toEqual(['npm', ['install', '--no-audit', '--no-fund', '--omit=dev']]);
    await installPackage('git:https://example.com/x/ext.git', { root, run });
    expect(calls[2]![0]).toBe('git');
    expect(calls[2]![1].slice(0, 2)).toEqual(['-C', gitDir]);
    expect((await readGlobal()).packages).toEqual(['git:https://example.com/x/ext.git']);
  });

  it('路径包不跑任何命令,目录必须存在;--local 记进项目配置', async () => {
    const run = vi.fn();
    await expect(installPackage('./nope', { root, run: run as never })).rejects.toThrow(/not a directory/);
    await fs.mkdir(path.join(root, 'local-ext'));
    const result = await installPackage('./local-ext', { root, scope: 'project', run: run as never });
    expect(run).not.toHaveBeenCalled();
    expect(result.dir).toBe(path.join(root, 'local-ext'));
    const project = JSON.parse(await fs.readFile(path.join(root, '.mojocode', 'config.json'), 'utf8')) as {
      packages: string[];
    };
    expect(project.packages).toEqual([path.join(root, 'local-ext')]);
  });
});

describe('removePackage / resolvePackages', () => {
  it('按名字卸载:npm 走 npm uninstall,git 删目录,路径包只去记录', async () => {
    const calls: string[] = [];
    const run: CommandRunner = vi.fn(async (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return { stdout: '', stderr: '' };
    });
    await fs.mkdir(path.join(root, 'p'));
    const gitDir = path.join(home, '.mojocode', 'packages', 'git', 'r');
    await fs.mkdir(gitDir, { recursive: true });
    // uninstall 只在那一层真的装了它时才跑,所以要把包目录也造出来。
    await fs.mkdir(path.join(home, '.mojocode', 'packages', 'npm', 'node_modules', 'n'), {
      recursive: true,
    });
    const configured = ['npm:n@1', 'git:https://h/o/r.git', path.join(root, 'p')];

    const npm = await removePackage('n', { root, run, configured });
    expect(npm.removed).toBe(true);
    expect(calls).toEqual(['npm uninstall --no-audit --no-fund --save n']);
    const git = await removePackage('r', { root, run, configured });
    expect(git.removed).toBe(true);
    await expect(fs.access(gitDir)).rejects.toThrow();
    const local = await removePackage('p', { root, run, configured });
    expect(local.removed).toBe(true);
    // Bun 的 fs.access resolve 成 null 而不是 undefined,只断言目录还在。
    await expect(fs.stat(path.join(root, 'p'))).resolves.toBeTruthy();
    expect((await removePackage('ghost', { root, run, configured })).removed).toBe(false);
  });

  it('resolvePackages:项目 base 优先于全局 base,找不到的进 missing', async () => {
    const source = parsePackageSource('npm:dual', root);
    const globalDir = packageDirOf(source, path.join(home, '.mojocode', 'packages'));
    const projectDir = packageDirOf(source, path.join(root, '.mojocode', 'packages'));
    await fs.mkdir(globalDir, { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
    const { packages, missing } = await resolvePackages(['npm:dual', 'npm:absent'], { root });
    expect(packages.map((p) => p.dir)).toEqual([projectDir]);
    expect(missing).toEqual(['npm:absent']);
  });
});
