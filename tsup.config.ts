import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.tsx' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  // 依赖保持 external:把 React/Ink/AI-SDK 打进一个文件收益甚微,
  // 还会破坏它们内部的动态 require。
  skipNodeModulesBundle: true,
  banner: { js: '#!/usr/bin/env node' },
});
