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
 */
let cached: string | undefined;

export function packageVersion(): string {
  if (cached === undefined) cached = findPackage()?.version ?? '0.0.0-dev';
  return cached;
}

/** 包根目录(含 package.json 的那一层);找不到时退回当前模块所在目录。 */
export function packageRoot(): string {
  return findPackage()?.dir ?? path.dirname(fileURLToPath(import.meta.url));
}

let found: { dir: string; version: string } | null | undefined;

function findPackage(): { dir: string; version: string } | undefined {
  if (found !== undefined) return found ?? undefined;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
      const json = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (json.name === APP_NAME && typeof json.version === 'string') {
        found = { dir, version: json.version };
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
