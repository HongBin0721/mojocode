/**
 * electron-vite 三端构建配置(main / preload / renderer)。
 *
 * 跨包引用:GUI 直接从仓库根的 src/ 编译 mojocode 的客户端层(@core/*
 * alias,白名单见 tsconfig.json 的同名 paths)。main 侧的 @core/remote
 * 会连带拉进根仓库的运行时依赖(ai、execa、zod…),它们一律 external——
 * 从根 package.json 的 dependencies 现读,保持与根包自动同步;运行时由
 * Node 沿 apps/desktop/node_modules → 根 node_modules 向上解析。
 * external 走 build.externalizeDeps 配置项(externalizeDepsPlugin 已
 * deprecated),include 语义 = 在本包 dependencies 自动检测之上追加名单
 * ——曾经写成不存在的 `external` 字段被静默忽略,根依赖全量内联进
 * out/main;本文件已纳入 tsconfig include,同类拼写错会在 typecheck 报红。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const rootDependencies = Object.keys(
  (JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  }).dependencies ?? {},
);

/** renderer 可安全引用的根仓库纯模块(与 tsconfig paths 一一对应)。 */
const rendererAliases = {
  '@core/protocol': resolve(repoRoot, 'src/server/protocol.ts'),
  '@core/events': resolve(repoRoot, 'src/core/events.ts'),
  '@core/types': resolve(repoRoot, 'src/ui/types.ts'),
  '@core/timeline-data': resolve(repoRoot, 'src/ui/timeline-data.ts'),
  '@core/schema': resolve(repoRoot, 'src/config/schema.ts'),
  '@core/providers': resolve(repoRoot, 'src/config/providers.ts'),
  '@core/attachments': resolve(repoRoot, 'src/app/attachments.ts'),
} as const;

/** main/preload 用到的根仓库模块(renderer 白名单的超集)。 */
const mainAliases = {
  ...rendererAliases,
  '@core/remote': resolve(repoRoot, 'src/client/remote.ts'),
  '@core/replay': resolve(repoRoot, 'src/session/replay.ts'),
  '@core/i18n': resolve(repoRoot, 'src/i18n/index.ts'),
  '@core/session-store': resolve(repoRoot, 'src/session/store.ts'),
} as const;

export default defineConfig({
  main: {
    resolve: { alias: { ...mainAliases } },
    build: {
      externalizeDeps: { include: rootDependencies },
      outDir: 'out/main',
      lib: { entry: resolve(repoRoot, 'apps/desktop/src/main/index.ts') },
    },
  },
  preload: {
    // externalizeDeps 默认开启(等价旧 externalizeDepsPlugin()),无需显式配置。
    resolve: { alias: { ...rendererAliases } },
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(repoRoot, 'apps/desktop/src/preload/index.ts') },
      // sandbox:true 的 preload 只能是 CJS(Electron 的 ESM preload 需要关
      // sandbox);type:module 包下 electron-vite 默认产 .mjs,这里钉住。
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.js' } },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: { alias: { ...rendererAliases } },
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(repoRoot, 'apps/desktop/src/renderer/index.html') },
    },
  },
});
