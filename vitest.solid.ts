import type { Plugin } from 'vitest/config';
import { transformAsync } from '@babel/core';

/**
 * Solid universal JSX 变换(babel-preset-solid,与 tsup 侧 esbuild-plugin-solid
 * 同参),vitest 两条车道共用:
 *  - UI 车道(vitest.ui.config.ts,Bun)自然需要;
 *  - 核心车道(vitest.config.ts,Node)也需要——部分核心测试 import 组件
 *    文件里的纯函数(如 TodoPanel 的 todoPanelRows),vitest 默认的 esbuild
 *    读到 tsconfig 的 jsx: preserve 会原样保留 JSX,import 分析直接语法报错。
 *
 * 刻意不用 vite-plugin-solid:它面向 DOM/SSR,测试模式下注入 jsdom 环境并把
 * `browser` 条件塞进 SSR 解析集,Bun fork worker 启动即崩。终端渲染只需要
 * JSX 编译这一件事。
 */
export function solidUniversal(): Plugin {
  return {
    name: 'solid-universal-jsx',
    enforce: 'pre',
    async transform(code, id) {
      const file = id.split('?')[0]!;
      if (!file.endsWith('.tsx') || file.includes('/node_modules/')) return null;
      const result = await transformAsync(code, {
        filename: file,
        babelrc: false,
        configFile: false,
        presets: [
          ['@babel/preset-typescript', {}],
          ['babel-preset-solid', { moduleName: '@opentui/solid', generate: 'universal' }],
        ],
        sourceMaps: true,
      });
      if (!result?.code) return null;
      return { code: result.code, map: result.map };
    },
  };
}
