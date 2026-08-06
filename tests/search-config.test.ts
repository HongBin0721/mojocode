import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configSchema, type PartialConfig } from '../src/config/schema.js';
import { loadRawConfig } from '../src/config/load.js';
import { resolveSearchBackend } from '../src/config/search.js';

function makeConfig(overrides: PartialConfig = {}) {
  return configSchema.parse(overrides);
}

describe('search 配置节 schema', () => {
  it('默认 backend=auto,permissions.allowNet 默认空数组', () => {
    const config = makeConfig();
    expect(config.search.backend).toBe('auto');
    expect(config.permissions.allowNet).toEqual([]);
  });

  it('拒绝非法 backend 与越界 count', () => {
    expect(() => makeConfig({ search: { backend: 'bing' as never } })).toThrow();
    expect(() => makeConfig({ search: { count: 50 } })).toThrow();
  });
});

describe('resolveSearchBackend', () => {
  it('auto:glm 优先于 exa,都无 key 返回 undefined', () => {
    const config = makeConfig();
    expect(resolveSearchBackend(config, { ZHIPU_API_KEY: 'z', EXA_API_KEY: 'e' })?.id).toBe('glm');
    expect(resolveSearchBackend(config, { EXA_API_KEY: 'e' })?.id).toBe('exa');
    expect(resolveSearchBackend(config, {})).toBeUndefined();
  });

  it('auto 刻意忽略专用 key(不知道属于谁)', () => {
    const config = makeConfig({ search: { apiKey: 'whose?' } });
    expect(resolveSearchBackend(config, { MOJOCODE_SEARCH_API_KEY: 'whose?' })).toBeUndefined();
  });

  it('显式 glm:专用 key 优先于预设 env;缺 key 返回 undefined', () => {
    const config = makeConfig({ search: { backend: 'glm' } });
    const resolved = resolveSearchBackend(config, {
      MOJOCODE_SEARCH_API_KEY: 'dedicated',
      ZHIPU_API_KEY: 'llm-key',
    });
    expect(resolved?.apiKey).toBe('dedicated');
    expect(resolveSearchBackend(config, {})).toBeUndefined();

    // 预设 env 回落 + baseURL 覆盖
    const overridden = makeConfig({ search: { backend: 'glm', baseURL: 'https://proxy.dev/ws' } });
    const viaEnv = resolveSearchBackend(overridden, { ZHIPU_API_KEY: 'llm-key' });
    expect(viaEnv?.apiKey).toBe('llm-key');
    expect(viaEnv?.endpoint).toBe('https://proxy.dev/ws');
  });

  it('custom:必须同时有 baseURL 与 key,契约走 bearer', () => {
    const noUrl = makeConfig({ search: { backend: 'custom', apiKey: 'k' } });
    expect(resolveSearchBackend(noUrl, {})).toBeUndefined();

    const full = makeConfig({ search: { backend: 'custom', apiKey: 'k', baseURL: 'https://s.dev/ws' } });
    const resolved = resolveSearchBackend(full, {});
    expect(resolved).toMatchObject({ id: 'custom', endpoint: 'https://s.dev/ws', auth: 'bearer' });
  });

  it('off 返回 undefined,即使有 key', () => {
    const config = makeConfig({ search: { backend: 'off' } });
    expect(resolveSearchBackend(config, { ZHIPU_API_KEY: 'z' })).toBeUndefined();
  });

  it('engine/count 透传', () => {
    const config = makeConfig({ search: { backend: 'glm', engine: 'search_pro', count: 8 } });
    const resolved = resolveSearchBackend(config, { ZHIPU_API_KEY: 'z' });
    expect(resolved?.engine).toBe('search_pro');
    expect(resolved?.count).toBe(8);
  });
});

describe('search 节的分层深合并', () => {
  let home: string;
  let root: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-search-home-'));
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-search-root-'));
    process.env.HOME = home;
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  it('项目层只写 engine 时,全局层的 backend 不被抹掉', async () => {
    await fs.mkdir(path.join(home, '.mojocode'), { recursive: true });
    await fs.writeFile(
      path.join(home, '.mojocode', 'config.json'),
      JSON.stringify({ search: { backend: 'exa' } }),
    );
    await fs.mkdir(path.join(root, '.mojocode'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.mojocode', 'config.json'),
      JSON.stringify({ search: { engine: 'search_pro' } }),
    );

    const { config } = await loadRawConfig({ root, env: {} });
    expect(config.search.backend).toBe('exa');
    expect(config.search.engine).toBe('search_pro');
  });

  it('MOJOCODE_SEARCH_BACKEND 覆盖文件层;非法值静默忽略', async () => {
    const { config } = await loadRawConfig({ root, env: { MOJOCODE_SEARCH_BACKEND: 'exa' } });
    expect(config.search.backend).toBe('exa');

    const bad = await loadRawConfig({ root, env: { MOJOCODE_SEARCH_BACKEND: 'bing' } });
    expect(bad.config.search.backend).toBe('auto');
  });

  it('显式后端缺 key 时 loadRawConfig 给出警告', async () => {
    await fs.mkdir(path.join(root, '.mojocode'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.mojocode', 'config.json'),
      JSON.stringify({ search: { backend: 'glm' } }),
    );
    const { warnings } = await loadRawConfig({ root, env: {} });
    expect(warnings.some((w) => w.includes('web_search will be unavailable'))).toBe(true);
  });
});
