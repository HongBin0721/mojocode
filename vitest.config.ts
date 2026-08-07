import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { solidUniversal } from './vitest.solid.js';

/**
 * 核心测试(Node 跑):`npm test`。
 * UI 测试在 tests/ui/ 下,需要原生 FFI,由 vitest.ui.config.ts 用 Bun 跑
 * (`npm run test:ui`),这里整体排除。
 *
 * Solid JSX 变换在这条车道同样需要:个别核心测试 import 组件文件里的纯函数
 * (如 TodoPanel 的 todoPanelRows),模块得先编译得过(见 vitest.solid.ts)。
 *
 * 这份配置也要能在 **Bun** 下跑(CI 的 bun job 会再跑一遍 `bun --bun x vitest
 * run`,守住双运行时兼容),所以 zod / solid-js 的解析陷阱这里同样要处理——
 * 与 vitest.ui.config.ts 同源,详见那边的长注释:
 *  - zod 的 ESM 入口是「import * as z 再 export { z }」,该绑定在 SSR 转换 +
 *    Bun 的组合下会丢,`import { z }` 拿到 undefined,schema.ts 顶层就炸;
 *    钉到 CJS 入口后具名导出由 cjs-module-lexer 静态识别,完好。
 *  - 裸 `solid-js` 在 Bun 的 worker 条件下解析到 dist/server.js(SSR 桩),
 *    钉到客户端构建 dist/solid.js 保证单实例。
 * 两个别名在 Node 下同样安全(CJS 具名互操作正常),故不按运行时分支。
 */
export default defineConfig({
  plugins: [solidUniversal()],
  resolve: {
    alias: [
      { find: /^zod$/, replacement: fileURLToPath(new URL('./node_modules/zod/index.cjs', import.meta.url)) },
      { find: /^solid-js$/, replacement: 'solid-js/dist/solid.js' },
      {
        find: /^@opentui\/solid$/,
        replacement: fileURLToPath(new URL('./node_modules/@opentui/solid/index.js', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', 'tests/ui/**'],
  },
});
