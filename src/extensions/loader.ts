/**
 * 磁盘扩展的发现与加载(Pi 式)。
 *
 * 三层来源,按这个顺序装(后装的同名命令/工具覆盖先装的):
 *  1. 包——`mojocode install` 装进来、记在配置 `packages` 里的(见 packages.ts);
 *  2. 全局目录 `~/.mojocode/extensions/`;
 *  3. 项目目录 `<root>/.mojocode/extensions/`;
 *  4. 配置 `extensions: [路径…]`(全局与项目层取并集);
 *  5. 命令行 `-e <path>`(可重复)。
 * 一方扩展(`BUILTIN_EXTENSIONS`)永远最先,不经这里。
 *
 * 目录里认 `*.ts` / `*.mts` / `*.js` / `*.mjs` 与 `<name>/index.<ext>`;`.d.ts`、
 * `*.test.*` 跳过。模块形状见 core/extension.ts 的 ExtensionModuleExport。
 *
 * TypeScript 的运行时加载:Bun 原生就认 `.ts`;Node 走 jiti(与 Pi 相同),
 * 按需 `import('jiti')`——只在真有磁盘扩展要装时才付这份代价。jiti 自带
 * 转译,不依赖 Node 版本的 type stripping。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Extension, ExtensionModuleExport } from '../core/extension.js';
import { globalExtensionsDir, projectExtensionsDir } from '../config/paths.js';
import type { ResolvedPackage } from './packages.js';
import { nameOf } from './packages.js';

export type ExtensionOrigin = 'package' | 'user' | 'project' | 'config' | 'flag';

export interface DiscoveredExtension {
  /** 缺省 id(模块自己导出 id 时以它为准)。 */
  id: string;
  file: string;
  origin: ExtensionOrigin;
  /** 来自哪个包(origin = package 时)。 */
  package?: string;
}

const MODULE_EXTS = ['.ts', '.mts', '.js', '.mjs'];
const INDEX_NAMES = MODULE_EXTS.map((ext) => `index${ext}`);

function isModuleFile(name: string): boolean {
  if (name.endsWith('.d.ts') || /\.test\.[cm]?[jt]s$/.test(name)) return false;
  return MODULE_EXTS.some((ext) => name.endsWith(ext));
}

function stem(file: string): string {
  const base = path.basename(file);
  const ext = MODULE_EXTS.find((e) => base.endsWith(e)) ?? path.extname(base);
  return base.slice(0, base.length - ext.length);
}

/** `foo.ts` → `foo`;`foo/index.ts` → `foo`。 */
export function defaultIdOf(file: string): string {
  const name = stem(file);
  return name === 'index' ? path.basename(path.dirname(file)) : name;
}

/** 扫一个扩展目录。不存在的目录是常态,返回空表。 */
export async function scanExtensionDir(
  dir: string,
  origin: ExtensionOrigin,
  pkg?: string,
): Promise<DiscoveredExtension[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  // 目录项之间互不相干,一起探;名字序在最后归位(装载顺序要可预期)。
  const probed = await Promise.all(
    entries
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map(async (entry): Promise<DiscoveredExtension | undefined> => {
        const full = path.join(dir, entry.name);
        if (entry.isFile() || entry.isSymbolicLink()) {
          return isModuleFile(entry.name) ? describe(full, origin, pkg) : undefined;
        }
        if (!entry.isDirectory()) return undefined;
        const hits = await Promise.all(INDEX_NAMES.map((index) => stat(path.join(full, index))));
        // 后缀是**有优先级**的(.ts 先于 .js),取第一个命中的。
        const index = INDEX_NAMES.find((_, i) => hits[i]);
        return index ? describe(path.join(full, index), origin, pkg) : undefined;
      }),
  );
  return probed.filter((entry): entry is DiscoveredExtension => entry !== undefined);
}

/** 存在即返回 stat,不存在返回 undefined——发现路径上"没有"是常态,不是错误。 */
function stat(file: string): Promise<import('node:fs').Stats | undefined> {
  return fs.stat(file).then(
    (s) => s,
    () => undefined,
  );
}

function describe(file: string, origin: ExtensionOrigin, pkg?: string): DiscoveredExtension {
  const base = defaultIdOf(file);
  return {
    id: pkg ? `${pkg}/${base}` : base,
    file,
    origin,
    ...(pkg ? { package: pkg } : {}),
  };
}

export interface DiscoverOptions {
  root: string;
  /** 命令行 `-e` 给的文件或目录。 */
  extraPaths?: readonly string[];
  /** 配置 `extensions` 列的文件或目录(相对路径按 root 解析),装在目录之后、`-e` 之前。 */
  configPaths?: readonly string[];
  /** 已解析到磁盘的包(见 packages.ts 的 resolvePackages)。 */
  packages?: readonly ResolvedPackage[];
}

export interface DiscoverResult {
  extensions: DiscoveredExtension[];
  /**
   * `-e` 指到的、磁盘上不存在的路径(绝对路径)。**不抛**:抛出去会把前面
   * 几个来源已经发现的扩展一起丢掉——一个 `-e` 打错字就让
   * `~/.mojocode/extensions/` 整个不加载,而用户只看到那条打错的提示。
   *
   * 这里给的是**路径而不是成句的英文**:这一层不认识 i18n(它也在 CLI 的
   * 非会话路径上跑),文案由调用方按自己的呈现方式本地化——与 `ReviewFailure`
   * → `FAILURE_NOTICES` 同一条分工。
   */
  notFound: string[];
}

/** 发现全部磁盘扩展,按装载顺序返回。只看磁盘,不加载。 */
export async function discoverExtensions(options: DiscoverOptions): Promise<DiscoverResult> {
  const notFound: string[] = [];

  /** 一个 manifest 条目 / `-e` 参数:目录就扫,文件就直接算一个。 */
  const expand = async (
    entry: string,
    origin: ExtensionOrigin,
    pkg?: string,
  ): Promise<DiscoveredExtension[] | undefined> => {
    const info = await stat(entry);
    if (!info) return undefined;
    return info.isDirectory() ? scanExtensionDir(entry, origin, pkg) : [describe(entry, origin, pkg)];
  };

  // 四类来源之间没有依赖,全部并发探;顺序在下面按装载优先级重新拼回来
  // (包 → 全局 → 项目 → `-e`,后装的同名覆盖先装的)。启动路径上这几十次
  // stat/readdir 串起来是纯粹的干等。
  const [fromPackages, fromUser, fromProject, fromConfig, fromFlags] = await Promise.all([
    Promise.all(
      (options.packages ?? []).map((pkg) => {
        const pkgName = nameOf(pkg.source);
        return Promise.all(pkg.manifest.extensions.map((entry) => expand(entry, 'package', pkgName)));
      }),
    ),
    scanExtensionDir(globalExtensionsDir(), 'user'),
    scanExtensionDir(projectExtensionsDir(options.root), 'project'),
    Promise.all(
      (options.configPaths ?? []).map(async (raw) => {
        const file = path.resolve(options.root, raw);
        return (await expand(file, 'config')) ?? { missing: file };
      }),
    ),
    Promise.all(
      (options.extraPaths ?? []).map(async (raw) => {
        const file = path.resolve(options.root, raw);
        return (await expand(file, 'flag')) ?? { missing: file };
      }),
    ),
  ]);

  const out: DiscoveredExtension[] = [];
  for (const pkg of fromPackages) for (const found of pkg) out.push(...(found ?? []));
  out.push(...fromUser, ...fromProject);
  for (const found of [...fromConfig, ...fromFlags]) {
    if (Array.isArray(found)) out.push(...found);
    else notFound.push(found.missing);
  }
  return { extensions: out, notFound };
}

/**
 * jiti 实例是**进程级单例**,不是每个文件一份:每个实例带自己的模块注册表,
 * 逐文件新建会让每个扩展把 zod/ai 这些共享依赖各自重新解析、重新求值一遍。
 * 实测三个各 import zod 的扩展:逐文件 106ms,共享一份 15ms——那是每个磁盘
 * 扩展 ~30ms 的纯启动延迟,而 GUI 最多同时跑四个 sidecar。
 * 仍然是**惰性**的:真有磁盘扩展要装时才付 `import('jiti')` 的代价。
 */
type Jiti = { import: (file: string) => Promise<unknown> };
const jitiByGeneration = new Map<number, Promise<Jiti>>();
/**
 * `/reload` 靠 generation 换一份新实例:jiti 按文件缓存模块,同一实例再
 * import 同一个文件拿到的是旧模块;新实例连共享依赖也重新求值一遍,那是
 * 重载的代价,不是启动的代价(启动永远是 generation 0 的那一份)。
 */
function jitiOf(generation: number): Promise<Jiti> {
  let promise = jitiByGeneration.get(generation);
  if (!promise) {
    promise = import('jiti').then(({ createJiti }) => createJiti(import.meta.url, { interopDefault: true }));
    // 旧代数的实例连同它的模块注册表一起丢掉:`/reload` 之后再也用不到它,
    // 留着就是每重载一次泄漏一份 zod/ai。(原生 import 那条路的 `?reload=N`
    // 图进的是运行时自己的 ESM 缓存,清不掉——那是重载固有的代价。)
    for (const old of [...jitiByGeneration.keys()]) {
      if (old < generation) jitiByGeneration.delete(old);
    }
    jitiByGeneration.set(generation, promise);
  }
  return promise;
}

/**
 * 加载一个模块文件。Bun 原生 import;Node 上 `.ts` / `.mts` 走 jiti,`.mjs` / `.js`
 * 先试原生 import(jiti 对它们本来也只是转交原生 import,而原生 import 的缓存
 * 按 URL 键——只有 query 能绕开),失败(CJS 形态的 `.js`)再退回 jiti。
 * generation > 0 是 `/reload`:原生路径用 query 绕开模块缓存,jiti 路径换新
 * 实例(实测 jiti 对 `.ts` 换实例即重读文件)。
 */
async function importExtensionModule(file: string, generation = 0): Promise<Record<string, unknown>> {
  const href = pathToFileURL(file).href;
  const busted = generation > 0 ? `${href}?reload=${generation}` : href;
  if (process.versions.bun) return (await import(busted)) as Record<string, unknown>;
  if (/\.m?js$/.test(file)) {
    try {
      return (await import(busted)) as Record<string, unknown>;
    } catch {
      // CJS 形态的 .js:交给 jiti 转译。
    }
  }
  const jiti = await jitiOf(generation);
  return (await jiti.import(file)) as Record<string, unknown>;
}

/** 把模块导出规范成 Extension;形状不对抛错(由调用方变成 notice)。 */
export async function loadExtension(
  discovered: DiscoveredExtension,
  options: { generation?: number } = {},
): Promise<Extension> {
  const mod = await importExtensionModule(discovered.file, options.generation ?? 0);
  const exported = (mod.default ?? mod) as ExtensionModuleExport | undefined;
  if (typeof exported === 'function') {
    return { id: discovered.id, setup: exported };
  }
  if (exported && typeof exported === 'object' && typeof exported.setup === 'function') {
    return { id: typeof exported.id === 'string' && exported.id ? exported.id : discovered.id, setup: exported.setup };
  }
  throw new Error(
    `${discovered.file} must export default a function (api) => void, or an object with a setup(api) method.`,
  );
}
