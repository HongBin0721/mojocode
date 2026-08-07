import { defineConfig } from 'tsup';

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
  // 依赖保持 external:把 React/AI-SDK 打进一个文件收益甚微,
  // 还会破坏它们内部的动态 require。
  skipNodeModulesBundle: true,
  banner: { js: '#!/usr/bin/env node' },
});
