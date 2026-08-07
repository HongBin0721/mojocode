import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { solidUniversal } from './vitest.solid.js';

/**
 * UI 测试专用配置,必须用 Bun 跑:`npm run test:ui`
 * (= bun --bun x vitest run --config vitest.ui.config.ts;`--bun` 不能省,
 * 否则 vitest 的 node shebang 会让整套测试悄悄跑在 Node 上)。
 *
 * OpenTUI 的测试渲染器是真原生渲染(FFI):Bun 走 `bun:ffi`,Node 走
 * `node:ffi`(需 26+ 与实验 flag)。vitest 默认按 node 条件解析 exports,
 * 即使进程是 Bun 也会拿到 index.node.js 而报「FFI not available」——
 * 这里把 `bun` 条件加进解析集,让 @opentui/* 解析到 bun 实现。
 *
 * 注意 `ssr.resolve.conditions` 是**整组替换**而非追加:必须把默认的
 * `module`/`node`/`import` 一并写回,否则 zod 这类包会落到 CJS 主入口,
 * CJS 互操作识别不出 `export { z }` 的具名导出(`import { z } from 'zod'`
 * 得到 undefined),schema.ts 顶层的 z.enum 在 import 期就炸。
 */

export default defineConfig({
  plugins: [solidUniversal()],
  resolve: {
    conditions: ['bun'],
    // zod 钉到 CJS 入口:它的 ESM 入口是「import * as z 再 export { z }」,
    // 这个绑定在本配置的 SSR 转换 + Bun 运行时组合下会丢(import { z }
    // 得到 undefined,schema.ts 顶层 z.enum 崩)。CJS 入口的 exports.z
    // 由 cjs-module-lexer 静态识别,具名导出完好。
    //
    // solid-js 钉到客户端构建:SSR 解析集里必须保留的 `node` 条件会把它
    // 解析到 dist/server.js(SSR 桩,信号全是假实现,组件静默不更新)。
    // @opentui/solid 内部 import 的也是这个文件,单实例。
    alias: [
      { find: /^zod$/, replacement: fileURLToPath(new URL('./node_modules/zod/index.cjs', import.meta.url)) },
      // solid-js 生态在 Bun 下的解析陷阱:Bun 原生条件(worker/node)把裸
      // `solid-js` 解析到 dist/server.js——SSR 桩,onMount/createEffect 全是
      // 空实现,组件首帧正常、事件订阅静默失效。@opentui/solid 的 bun 变体
      // (index.bun.js)靠官方 Bun 加载器插件在运行期偷换内容,vitest 的
      // fork worker 不经过那条路。解法:全部钉到 **node 变体**——
      // index.js 把 solid-js 预钉在 dist/solid.js(客户端构建),自身除
      // @opentui/core(按运行时条件解析,Bun 下仍拿 bun:ffi 实现)外无其他
      // 运行时分支;我们的代码也别名到同一个 solid.js,单实例。
      { find: /^solid-js$/, replacement: 'solid-js/dist/solid.js' },
      {
        find: /^@opentui\/solid$/,
        replacement: fileURLToPath(new URL('./node_modules/@opentui/solid/index.js', import.meta.url)),
      },
    ],
  },
  ssr: {
    resolve: {
      conditions: ['bun', 'module', 'node', 'import', 'development|production'],
    },
  },
  test: {
    include: ['tests/ui/*.test.{ts,tsx}'],
    // fork 池:每个文件独立进程,原生渲染器泄漏不会互相污染。
    pool: 'forks',
  },
});
