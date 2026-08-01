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
  // Keep deps external: bundling React/Ink/AI-SDK into one file buys little and
  // breaks their internal dynamic requires.
  skipNodeModulesBundle: true,
  banner: { js: '#!/usr/bin/env node' },
});
