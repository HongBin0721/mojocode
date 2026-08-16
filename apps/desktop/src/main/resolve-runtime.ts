/**
 * 解析受管 server 的运行时:跑哪个 Node、哪个 cli.js。
 *
 * dev:系统 node(要求 ≥ 22,与 CLI 的 engines 一致)+ 仓库根的 dist/cli.js
 * (前置:根目录 `npm run build`)。两者都可用环境变量覆盖,CI/调试时不必
 * 先构建。
 *
 * 打包:Electron 自带二进制按 Node 跑(ELECTRON_RUN_AS_NODE=1,内嵌 Node
 * ≥ 22)+ extraResources 里的 cli.js(electron-builder 配置在 M4 落地)。
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { app } from 'electron';

export interface ServerRuntime {
  nodeBin: string;
  cliJs: string;
  /** true = spawn 时注入 ELECTRON_RUN_AS_NODE=1(打包态)。 */
  runAsNode: boolean;
}

export function resolveCliJs(): string {
  const fromEnv = process.env.MOJOCODE_CLI_JS;
  if (fromEnv) return fromEnv;
  if (app.isPackaged) {
    const packaged = resolve(process.resourcesPath, 'mojocode/cli.js');
    if (existsSync(packaged)) return packaged;
    throw new Error(`打包资源里找不到 mojocode CLI(期望 ${packaged})`);
  }
  // dev:从 app 路径(apps/desktop)向上找仓库根的 dist/cli.js。
  let dir = app.getAppPath();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, 'dist/cli.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    '找不到 mojocode CLI(dist/cli.js)。先在仓库根目录跑 `npm run build`,或用 MOJOCODE_CLI_JS 指定入口路径。',
  );
}

export function resolveRuntime(): ServerRuntime {
  const nodeFromEnv = process.env.MOJOCODE_NODE_BIN;
  if (nodeFromEnv) return { nodeBin: nodeFromEnv, cliJs: resolveCliJs(), runAsNode: false };
  if (app.isPackaged) {
    // Electron 二进制按 Node 跑:spawn 时带 ELECTRON_RUN_AS_NODE=1。
    return { nodeBin: process.execPath, cliJs: resolveCliJs(), runAsNode: true };
  }
  return { nodeBin: 'node', cliJs: resolveCliJs(), runAsNode: false };
}
