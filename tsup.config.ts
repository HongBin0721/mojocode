import { defineConfig } from 'tsup';
import { solidPlugin } from 'esbuild-plugin-solid';

export default defineConfig({
  entry: { cli: 'src/cli.tsx' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // 代码分割必须开:cli 对 './ui/tui.js' 的动态 import 要生成独立 chunk,
  // 其模块级的 @opentui/core 引用(原生 FFI)才真正做到按需加载——
  // Node 20 跑 `-p` 与子命令时该 chunk 从不加载。关掉的话 esbuild 会把
  // 动态 import 内联进主文件,FFI 依赖变成启动期硬依赖。
  splitting: true,
  // 依赖保持 external:把 Solid/AI-SDK 打进一个文件收益甚微,
  // 还会破坏它们内部的动态 require。
  skipNodeModulesBundle: true,
  // 唯一例外:@opentui/solid **冻结 node 变体进 chunk**。它的 exports 按
  // 运行时分流,bun 变体 import 裸 `solid-js`——Bun 的原生条件(worker)
  // 会解析到 dist/server.js(SSR 桩,onMount 等全是空实现,键盘订阅静默
  // 失效;上游靠 Bun 加载器插件运行期偷换内容,我们的分发产物不带那层)。
  // esbuild 按 node 条件解析到的 node 变体把 solid-js 预钉在客户端构建
  // dist/solid.js;它 import 的 @opentui/core 仍 external,按运行时拿 FFI 实现。
  noExternal: ['@opentui/solid'],
  banner: { js: '#!/usr/bin/env node' },
  plugins: [
    {
      // 我们源码里的裸 `solid-js` 同样钉到客户端构建。tsup 把 package.json
      // 的 dependencies 在用户 esbuild 插件之前就整体 external,onResolve
      // 层面改写轮不到——只能在产物层改写说明符。改写后与 @opentui/solid
      // node 变体内部的 import 同一模块 id:单实例是 Solid 响应式能工作的
      // 前提(双实例 = 信号建在 A、效果建在 B,更新永远不追踪)。
      name: 'pin-solid-client',
      renderChunk(code) {
        return { code: code.replace(/from\s*"solid-js"/g, 'from "solid-js/dist/solid.js"') };
      },
    },
  ],
  esbuildPlugins: [
    // esbuild 原生编译不了 Solid JSX(需要 babel 的 dom-expressions 变换)。
    // universal + moduleName:编译产物从 @opentui/solid 导入 createElement/
    // insert/spread 等运行时,对接 OpenTUI 的自定义渲染器。
    solidPlugin({ solid: { moduleName: '@opentui/solid', generate: 'universal' } }),
  ],
});
