/**
 * GUI 侧测试配置:独立于根仓库的 vitest(apps/desktop 是独立包,根 config
 * 的 include 锚定在根 tests/,互不可见)。
 *
 * 默认 node 环境(main/preload 侧);renderer 组件测试在文件头用
 * `@vitest-environment jsdom` docblock 声明。alias 与 electron.vite.config.ts
 * 的 mainAliases 保持一致(测试两端的 import 都要能解析)。
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkgDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(pkgDir, '../..');

const aliases = {
  '@core/protocol': resolve(repoRoot, 'src/server/protocol.ts'),
  '@core/events': resolve(repoRoot, 'src/core/events.ts'),
  '@core/types': resolve(repoRoot, 'src/ui/types.ts'),
  '@core/timeline-data': resolve(repoRoot, 'src/ui/timeline-data.ts'),
  '@core/schema': resolve(repoRoot, 'src/config/schema.ts'),
  '@core/providers': resolve(repoRoot, 'src/config/providers.ts'),
  '@core/attachments': resolve(repoRoot, 'src/app/attachments.ts'),
  '@core/remote': resolve(repoRoot, 'src/client/remote.ts'),
  '@core/replay': resolve(repoRoot, 'src/session/replay.ts'),
  '@core/i18n': resolve(repoRoot, 'src/i18n/index.ts'),
  '@core/session-store': resolve(repoRoot, 'src/session/store.ts'),
};

export default defineConfig({
  resolve: { alias: aliases },
  // JSX 自动 runtime(与 @vitejs/plugin-react 的构建行为一致)。
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
  },
});
