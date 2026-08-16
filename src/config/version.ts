import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME } from './paths.js';

/**
 * 本包的版本号,取自 package.json。
 *
 * 不写死字面量:源码里写一份、package.json 里再写一份,迟早会对不上
 * (`--version` 曾长期停在 0.1.0,而发布的是 0.1.1)。源码目录
 * (`src/config/`)与打包产物(`dist/`)到包根的层级不同,所以逐级向上找,
 * 并用 `name` 字段确认找到的确实是本包,而不是恰好在上层的宿主项目。
 *
 * 单二进制(`bun build --compile`)里没有 package.json 可读——模块被打进
 * `$bunfs`,向上找只会得到 `0.0.0-dev`。因此构建脚本用 `--define` 把
 * `MOJOCODE_BUILD_VERSION` 替换成字面量,这里优先读它;Node/tsup 路径下
 * 该标识符不存在,`typeof` 守卫安全返回 undefined,继续走 fs 查找。
 */
declare const MOJOCODE_BUILD_VERSION: string | undefined;

/** build-time 注入的版本号;非编译产物里为 undefined。 */
const injectedVersion: string | undefined =
  typeof MOJOCODE_BUILD_VERSION === 'string' ? MOJOCODE_BUILD_VERSION : undefined;

/** 是否运行在 `bun build --compile` 出的单二进制里(以版本注入为标志)。 */
export function isCompiledBinary(): boolean {
  return injectedVersion !== undefined;
}

/** 仓库主页。写死而非读 package.json:单二进制里没有 package.json 可读。 */
export const REPO_URL = 'https://github.com/HongBin0721/mojocode';

let cached: string | undefined;

export function packageVersion(): string {
  if (cached === undefined) cached = injectedVersion ?? findPackage()?.version ?? '0.0.0-dev';
  return cached;
}

/**
 * 包根目录(含 package.json 的那一层);找不到时退回当前模块所在目录。
 * 单二进制里不存在包根,退回二进制自身所在目录(doctor 的安装位置检查用)。
 */
export function packageRoot(): string {
  if (isCompiledBinary()) return path.dirname(process.execPath);
  return findPackage()?.dir ?? path.dirname(fileURLToPath(import.meta.url));
}

/**
 * engines.node 要求的最低 Node 主版本。读 package.json 而非写死字面量:
 * floor 抬高时 CLAUDE.md 要求 engines/CI/README 三处同步,doctor 的检查
 * 提示不该是第四份要手改的地方(曾经写死 20,而 floor 早已抬到 22)。
 * 读不到(单二进制)时退回已知下限——那里运行的是打包进来的 Bun,
 * 本检查不适用,纯兜底。
 */
export function nodeMinMajor(): number {
  const floor = findPackage()?.enginesNode?.match(/>=\s*v?(\d+)/)?.[1];
  const major = floor !== undefined ? Number.parseInt(floor, 10) : NaN;
  return Number.isFinite(major) && major > 0 ? major : 22;
}

let found: { dir: string; version: string; enginesNode?: string } | null | undefined;

function findPackage(): { dir: string; version: string; enginesNode?: string } | undefined {
  if (found !== undefined) return found ?? undefined;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
      const json = JSON.parse(raw) as { name?: unknown; version?: unknown; engines?: unknown };
      if (json.name === APP_NAME && typeof json.version === 'string') {
        const engines = (json.engines ?? {}) as { node?: unknown };
        found = {
          dir,
          version: json.version,
          enginesNode: typeof engines.node === 'string' ? engines.node : undefined,
        };
        return found;
      }
    } catch {
      // 这一层没有 package.json 或读不动,继续往上找。
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  found = null;
  return undefined;
}
