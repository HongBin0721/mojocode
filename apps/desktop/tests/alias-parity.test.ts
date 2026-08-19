/**
 * @core/* 别名多份拷贝的一致性看护:tsconfig.json / tsconfig.renderer.json /
 * electron.vite.config.ts(main + renderer 两组)/ vitest.config.ts 各自维护
 * 一份别名表,任何一处增删漏改都是「typecheck 过、build 才炸」级别的漂移。
 *
 * tsconfig 带注释不能 JSON.parse,用正则从文本提取;两个 config 模块顶层
 * 无副作用(electron.vite.config 只 readFileSync 根 package.json + 调 react()
 * 插件工厂),node 环境可安全 import —— 将来若配置加了副作用会污染本测试,
 * 加之前先想清楚。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import electronViteConfig from '../electron.vite.config.js';
import vitestConfig from '../vitest.config.js';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 从 tsconfig 文本提取 paths 的 @core 条目(键 → 解析为绝对路径的值)。 */
function tsconfigCoreEntries(file: string): Map<string, string> {
  const text = readFileSync(resolve(pkgDir, file), 'utf8');
  const entries = new Map<string, string>();
  for (const match of text.matchAll(/"(@core\/[^"]+)":\s*\["([^"]+)"\]/g)) {
    entries.set(match[1]!, resolve(pkgDir, match[2]!));
  }
  return entries;
}

function aliasEntries(alias: unknown): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(alias as Record<string, string>)) {
    if (key.startsWith('@core/')) entries.set(key, resolve(value));
  }
  return entries;
}

function expectSameEntries(actual: Map<string, string>, expected: Map<string, string>): void {
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
  for (const [key, value] of expected) expect(actual.get(key), key).toBe(value);
}

describe('@core 别名多份拷贝一致', () => {
  const tsMain = tsconfigCoreEntries('tsconfig.json');
  const tsRenderer = tsconfigCoreEntries('tsconfig.renderer.json');
  const viteMain = aliasEntries((electronViteConfig as { main: { resolve: { alias: unknown } } }).main.resolve.alias);
  const viteRenderer = aliasEntries(
    (electronViteConfig as { renderer: { resolve: { alias: unknown } } }).renderer.resolve.alias,
  );
  const vitestAliases = aliasEntries((vitestConfig as { resolve: { alias: unknown } }).resolve.alias);

  it('main 侧三份一致(tsconfig.json / vite mainAliases / vitest)', () => {
    expect(tsMain.size).toBeGreaterThan(0);
    expectSameEntries(viteMain, tsMain);
    expectSameEntries(vitestAliases, tsMain);
  });

  it('renderer 侧两份一致(tsconfig.renderer.json / vite rendererAliases)', () => {
    expect(tsRenderer.size).toBeGreaterThan(0);
    expectSameEntries(viteRenderer, tsRenderer);
  });

  it('renderer 白名单是 main 的真子集', () => {
    expect(tsRenderer.size).toBeLessThan(tsMain.size);
    for (const [key, value] of tsRenderer) expect(tsMain.get(key), key).toBe(value);
  });
});
