/**
 * 扩展包:`mojocode install npm:<name> | git:<url> | <路径>`(Pi 的 `pi install`)。
 *
 * 一个包就是一个目录,`package.json` 里可选一段 manifest:
 *
 *   "mojocode": { "extensions": ["extensions", "index.ts"], "skills": ["skills"] }
 *
 * 列表项是相对包根的文件或目录:文件直接当扩展模块加载,目录按扩展目录
 * 的规则扫描(`*.ts`/`*.js`/`<name>/index.ts`)。没有 manifest 时按约定找:
 * `extensions/` 目录、根目录的 `index.{ts,js,mjs}`、`skills/` 目录。
 *
 * 装到哪:全局 `~/.mojocode/packages`,`--local` 时 `<root>/.mojocode/packages`。
 * npm 包装进 `<base>/npm/node_modules/<name>`(那一层有个私有 package.json,
 * 交给 npm 自己管依赖树);git 包克隆到 `<base>/git/<name>`,带依赖就再跑一次
 * `npm install`;路径包不拷贝、原地加载。装好把原始 spec 记进配置的 `packages`,
 * 启动时据此再解析一遍。
 *
 * 外部命令(npm / git)经 `run` 注入:测试里换成假的,断言 argv 而不真联网。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import {
  globalConfigPath,
  globalPackagesDir,
  projectConfigPath,
  projectPackagesDir,
} from '../config/paths.js';
import { updateGlobalConfig, updateProjectConfig } from '../config/save.js';

export type PackageSource =
  | { kind: 'npm'; spec: string; name: string; requested: string }
  | { kind: 'git'; spec: string; url: string; name: string }
  | { kind: 'path'; spec: string; dir: string };

export interface PackageScopeOptions {
  root: string;
  /** `global`(默认)装进 `~/.mojocode`,`project` 装进 `<root>/.mojocode`。 */
  scope?: 'global' | 'project';
}

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: CommandRunner = async (command, args, cwd) => {
  const result = await execa(command, args, { cwd, reject: false, all: false });
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').at(-1) ?? '';
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
};

/**
 * 解析用户给的 spec。`npm:` / `git:` 前缀显式指定;裸 URL(`https://…`、
 * `git@…`)按 git;其余按路径,相对路径以 cwd 为基准解析成绝对路径——记进
 * 配置的是绝对路径,换个目录启动也解析得到。
 */
export function parsePackageSource(spec: string, cwd: string): PackageSource {
  const trimmed = spec.trim();
  if (trimmed.startsWith('npm:')) {
    const requested = trimmed.slice(4);
    return { kind: 'npm', spec: trimmed, name: npmNameOf(requested), requested };
  }
  if (trimmed.startsWith('git:')) {
    const url = trimmed.slice(4);
    return { kind: 'git', spec: trimmed, url, name: gitNameOf(url) };
  }
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(trimmed)) {
    return { kind: 'git', spec: `git:${trimmed}`, url: trimmed, name: gitNameOf(trimmed) };
  }
  const dir = path.resolve(cwd, trimmed);
  return { kind: 'path', spec: dir, dir };
}

/** `@scope/name@1.2.3` → `@scope/name`;`name@^1` → `name`。 */
function npmNameOf(requested: string): string {
  const at = requested.indexOf('@', requested.startsWith('@') ? 1 : 0);
  return at > 0 ? requested.slice(0, at) : requested;
}

/** 仓库 URL 的最后一段(去 `.git`),作为克隆目录名与卸载时的名字。 */
function gitNameOf(url: string): string {
  const tail = url.replace(/\/+$/, '').split(/[/:]/).at(-1) ?? 'package';
  return tail.replace(/\.git$/, '') || 'package';
}

function packagesBase(opts: PackageScopeOptions): string {
  return opts.scope === 'project' ? projectPackagesDir(opts.root) : globalPackagesDir();
}

/** 一个 spec 在某个 base 下的落点(不检查存在与否)。 */
export function packageDirOf(source: PackageSource, base: string): string {
  switch (source.kind) {
    case 'npm':
      return path.join(base, 'npm', 'node_modules', ...source.name.split('/'));
    case 'git':
      return path.join(base, 'git', source.name);
    case 'path':
      return source.dir;
  }
}

export interface PackageManifest {
  /** 扩展模块或扩展目录(绝对路径)。 */
  extensions: string[];
  /** 技能目录(绝对路径)。 */
  skills: string[];
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读包的 manifest。写了 `mojocode` 段就按它;没写按约定目录找。列出来但
 * 不存在的路径静默跳过——manifest 是包作者写的,写错不该让别的扩展装不上。
 */
export async function readPackageManifest(dir: string): Promise<PackageManifest> {
  let declared: { extensions?: unknown; skills?: unknown } | undefined;
  try {
    const json = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as {
      mojocode?: { extensions?: unknown; skills?: unknown };
    };
    declared = json.mojocode;
  } catch {
    declared = undefined;
  }

  if (declared) {
    const resolved = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string').map((rel) => path.resolve(dir, rel))
        : [];
    // 列出来但不存在的静默丢掉(见上)。两列互不相干,一起探。
    const [extensions, skills] = await Promise.all([
      keepExisting(resolved(declared.extensions)),
      keepExisting(resolved(declared.skills)),
    ]);
    return { extensions, skills };
  }

  // 约定路径是**探出来的**,不必再 keepExisting 一遍——原来那趟收尾把每条
  // 路径又 stat 了一次,而它刚刚正是靠 stat 才进的表。
  const [extensions, skills] = await Promise.all([conventionExtensions(dir), conventionSkills(dir)]);
  return { extensions, skills };
}

async function keepExisting(list: readonly string[]): Promise<string[]> {
  const alive = await Promise.all(list.map(exists));
  return list.filter((_, i) => alive[i]);
}

/** 没写 manifest 时的扩展约定:`extensions/` 目录,否则根目录的 `index.*`。 */
async function conventionExtensions(dir: string): Promise<string[]> {
  const extDir = path.join(dir, 'extensions');
  if (await exists(extDir)) return [extDir];
  const names = ['index.ts', 'index.mts', 'index.js', 'index.mjs'];
  const found = await Promise.all(names.map((name) => exists(path.join(dir, name))));
  const hit = names.find((_, i) => found[i]);
  return hit ? [path.join(dir, hit)] : [];
}

/** 没写 manifest 时的技能约定:`skills/` 目录。 */
async function conventionSkills(dir: string): Promise<string[]> {
  const skillsDir = path.join(dir, 'skills');
  return (await exists(skillsDir)) ? [skillsDir] : [];
}

export interface ResolvedPackage {
  spec: string;
  source: PackageSource;
  dir: string;
  manifest: PackageManifest;
}

/**
 * 把配置里记下的 spec 解析到磁盘:项目 base 先于全局 base(`--local` 装的
 * 优先),都找不到的进 `missing`——启动时提示用户重新 install,不抛错。
 */
export async function resolvePackages(
  specs: readonly string[],
  opts: { root: string },
): Promise<{ packages: ResolvedPackage[]; missing: string[] }> {
  // 每个 spec 之间毫无依赖,而每个都要 stat 两个候选目录 + 读一次
  // package.json:串起来就是启动路径上 N 趟往返。并发解析,再按原顺序归位
  // (装载顺序是有意义的——后装的同名命令覆盖先装的)。
  const resolved = await Promise.all(
    specs.map(async (spec) => {
      const source = parsePackageSource(spec, opts.root);
      const candidates =
        source.kind === 'path'
          ? [source.dir]
          : [packageDirOf(source, projectPackagesDir(opts.root)), packageDirOf(source, globalPackagesDir())];
      // 候选是**有优先级**的(项目 base 先于全局),所以这里必须顺序试。
      for (const candidate of candidates) {
        if (await exists(candidate)) {
          return { spec, source, dir: candidate, manifest: await readPackageManifest(candidate) };
        }
      }
      return undefined;
    }),
  );
  const packages: ResolvedPackage[] = [];
  const missing: string[] = [];
  resolved.forEach((entry, i) => (entry ? packages.push(entry) : missing.push(specs[i]!)));
  return { packages, missing };
}

/** 安装并记进配置。返回落点目录与写了哪个配置文件。 */
export async function installPackage(
  spec: string,
  opts: PackageScopeOptions & { run?: CommandRunner },
): Promise<{ source: PackageSource; dir: string; configFile: string }> {
  const run = opts.run ?? defaultRunner;
  const source = parsePackageSource(spec, opts.root);
  const base = packagesBase(opts);
  const dir = packageDirOf(source, base);

  // 穷尽 switch 而不是 if / else-if / else:PackageSource 是可辨识联合,加第
  // 四种来源时编译器会在这里点名——`else` 会把它默默当成路径包,一条命令都
  // 不跑就"装好了"。
  switch (source.kind) {
    case 'npm': {
      const npmRoot = path.join(base, 'npm');
      await fs.mkdir(npmRoot, { recursive: true });
      const manifest = path.join(npmRoot, 'package.json');
      if (!(await exists(manifest))) {
        await fs.writeFile(
          manifest,
          `${JSON.stringify({ name: 'mojocode-packages', private: true }, null, 2)}\n`,
          'utf8',
        );
      }
      await run('npm', ['install', '--no-audit', '--no-fund', '--save', source.requested], npmRoot);
      break;
    }
    case 'git': {
      await fs.mkdir(path.dirname(dir), { recursive: true });
      if (await exists(dir)) await run('git', ['-C', dir, 'pull', '--ff-only'], path.dirname(dir));
      else await run('git', ['clone', '--depth', '1', source.url, dir], path.dirname(dir));
      if (await hasDependencies(dir)) {
        await run('npm', ['install', '--no-audit', '--no-fund', '--omit=dev'], dir);
      }
      break;
    }
    case 'path': {
      // 不拷贝、原地加载,所以唯一要做的是确认它真的是个目录。
      const stat = await fs.stat(dir).catch(() => undefined);
      if (!stat?.isDirectory()) throw new Error(`Package path is not a directory: ${dir}`);
      break;
    }
  }

  const record = (config: Record<string, unknown>): void => {
    const list = Array.isArray(config.packages) ? (config.packages as unknown[]).map(String) : [];
    if (!list.includes(source.spec)) list.push(source.spec);
    config.packages = list;
  };
  const configFile =
    opts.scope === 'project'
      ? await updateProjectConfig(opts.root, record)
      : await updateGlobalConfig(record);
  return { source, dir, configFile };
}

async function hasDependencies(dir: string): Promise<boolean> {
  try {
    const json = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    return Object.keys(json.dependencies ?? {}).length > 0;
  } catch {
    return false;
  }
}

/**
 * 卸载:按名字(npm 包名 / git 目录名 / 路径包的目录名或完整 spec)在配置里
 * 找到那一条,删目录、去记录。找不到返回 false。
 *
 * **两个 base、两层配置都清**,不看 scope:`configured` 来自合并后的配置,
 * 用户根本不必记得当初是不是加了 `--local`。只按一个 scope 清的话,卸载一个
 * `--local` 装的包会「报成功但什么都没做」——包继续每次启动加载。
 * 只有那一层的配置文件**确实记着**这条 spec 时才回写,免得凭空给项目建一个
 * 只含空 `packages` 的配置文件。
 */
export async function removePackage(
  name: string,
  opts: { root: string; run?: CommandRunner; configured: readonly string[] },
): Promise<{ removed: boolean; configFiles: string[] }> {
  const run = opts.run ?? defaultRunner;
  const target = opts.configured
    .map((spec) => ({ spec, source: parsePackageSource(spec, opts.root) }))
    .find(({ spec, source }) => spec === name || nameOf(source) === name);
  if (!target) return { removed: false, configFiles: [] };

  for (const base of [projectPackagesDir(opts.root), globalPackagesDir()]) {
    const dir = packageDirOf(target.source, base);
    switch (target.source.kind) {
      case 'npm': {
        const npmRoot = path.join(base, 'npm');
        // 只在那一层真的装了它时才跑 uninstall:对没装过的包跑一次纯属噪音。
        if (await exists(dir)) {
          await run('npm', ['uninstall', '--no-audit', '--no-fund', '--save', target.source.name], npmRoot);
        }
        break;
      }
      case 'git':
        await fs.rm(dir, { recursive: true, force: true });
        break;
      case 'path':
        // 只去记录:目录是用户自己的,不替他删。
        break;
    }
  }

  const strip = (config: Record<string, unknown>): void => {
    const list = Array.isArray(config.packages) ? (config.packages as unknown[]).map(String) : [];
    config.packages = list.filter((spec) => spec !== target.spec);
  };
  const configFiles: string[] = [];
  if (await layerRecords(projectConfigPath(opts.root), target.spec)) {
    configFiles.push(await updateProjectConfig(opts.root, strip));
  }
  if (await layerRecords(globalConfigPath(), target.spec)) {
    configFiles.push(await updateGlobalConfig(strip));
  }
  return { removed: true, configFiles };
}

/** 这一层的配置文件里是否列着这条 spec(读不到/没写过都算否)。 */
async function layerRecords(file: string, spec: string): Promise<boolean> {
  try {
    const json = JSON.parse(await fs.readFile(file, 'utf8')) as { packages?: unknown };
    return Array.isArray(json.packages) && json.packages.map(String).includes(spec);
  } catch {
    return false;
  }
}

/** 用户口中的"名字":npm 包名、git 仓库名、路径包的目录名。 */
export function nameOf(source: PackageSource): string {
  return source.kind === 'path' ? path.basename(source.dir) : source.name;
}
