import { defineConfig } from 'vitest/config';
import { solidUniversal } from './vitest.solid.js';

/**
 * 核心测试(Node 跑):`npm test`。
 * UI 测试在 tests/ui/ 下,需要原生 FFI,由 vitest.ui.config.ts 用 Bun 跑
 * (`npm run test:ui`),这里整体排除。
 *
 * Solid JSX 变换在这条车道同样需要:个别核心测试 import 组件文件里的纯函数
 * (如 TodoPanel 的 todoPanelRows),模块得先编译得过(见 vitest.solid.ts)。
 */
export default defineConfig({
  plugins: [solidUniversal()],
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'tests/ui/**'],
  },
});
