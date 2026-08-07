import { defineConfig } from 'vitest/config';

/**
 * 核心测试(Node 跑):`npm test`。
 * UI 测试在 tests/ui/ 下,需要原生 FFI,由 vitest.ui.config.ts 用 Bun 跑
 * (`npm run test:ui`),这里整体排除。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'tests/ui/**'],
  },
});
