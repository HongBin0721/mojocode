import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  saveApiKey,
  saveCustomProvider,
  saveReasoningEffort,
  saveTheme,
  setDefaultProvider,
} from '../src/config/save.js';
import { globalConfigPath, projectConfigPath } from '../src/config/paths.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-save-'));
  file = path.join(dir, 'nested', 'config.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
}

describe('saveApiKey', () => {
  it('creates the file and parent directory with mode 0600', async () => {
    await saveApiKey('glm', 'secret-key', { file });
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await readConfig()).toEqual({ providers: { glm: { apiKey: 'secret-key' } } });
  });

  it('preserves unrelated settings and other providers', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        permissionMode: 'acceptEdits',
        providers: { kimi: { apiKey: 'k1', model: 'kimi-k3' } },
      }),
    );

    await saveApiKey('glm', 'g1', { file });

    expect(await readConfig()).toEqual({
      permissionMode: 'acceptEdits',
      providers: {
        kimi: { apiKey: 'k1', model: 'kimi-k3' },
        glm: { apiKey: 'g1' },
      },
    });
  });

  it('overwrites an existing key but keeps sibling fields of that provider', async () => {
    await saveApiKey('glm', 'old', { file });
    await fs.writeFile(
      file,
      JSON.stringify({ providers: { glm: { apiKey: 'old', model: 'GLM-5' } } }),
    );

    await saveApiKey('glm', 'new', { file });
    expect(await readConfig()).toEqual({ providers: { glm: { apiKey: 'new', model: 'GLM-5' } } });
  });

  it('can set the default provider in the same call', async () => {
    await saveApiKey('deepseek', 'd1', { file, setDefault: true });
    expect((await readConfig()).provider).toBe('deepseek');
  });
});

describe('saveCustomProvider', () => {
  it('writes baseURL and key, preserving an existing model choice', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ providers: { 'custom-openrouter-ai': { model: 'qwen3-coder' } } }),
    );

    await saveCustomProvider(
      'custom-openrouter-ai',
      { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'or-1' },
      file,
    );

    expect(await readConfig()).toEqual({
      providers: {
        'custom-openrouter-ai': { model: 'qwen3-coder', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'or-1' },
      },
    });
  });

  it('omits the apiKey field for keyless local endpoints', async () => {
    await saveCustomProvider('custom-ollama', { baseURL: 'http://127.0.0.1:11434/v1' }, file);
    const config = await readConfig();
    expect(config).toEqual({
      providers: { 'custom-ollama': { baseURL: 'http://127.0.0.1:11434/v1' } },
    });
    // 再配一次带 key 的同地址:apiKey 字段补上,baseURL 不重复。
    await saveCustomProvider(
      'custom-ollama',
      { baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'k' },
      file,
    );
    expect(await readConfig()).toEqual({
      providers: { 'custom-ollama': { baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'k' } },
    });
  });
});


describe('saveReasoningEffort', () => {
  it('writes providers.<id>.reasoningEffort and keeps sibling fields', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        reasoningEffort: 'low',
        providers: { glm: { apiKey: 'g1', model: 'GLM-5' } },
      }),
    );

    await saveReasoningEffort('glm', 'high', file);

    expect(await readConfig()).toEqual({
      reasoningEffort: 'low',
      providers: { glm: { apiKey: 'g1', model: 'GLM-5', reasoningEffort: 'high' } },
    });
  });

  it('creates the providers entry when missing', async () => {
    await saveReasoningEffort('kimi', 'max', file);
    expect(await readConfig()).toEqual({ providers: { kimi: { reasoningEffort: 'max' } } });
  });
});

describe('setDefaultProvider', () => {
  it('changes the default without touching stored keys', async () => {
    await saveApiKey('glm', 'g1', { file });
    await setDefaultProvider('glm', file);

    expect(await readConfig()).toEqual({
      providers: { glm: { apiKey: 'g1' } },
      provider: 'glm',
    });
  });
});

describe('saveTheme', () => {
  // 走真实路径(HOME 与工作区根都指到临时目录):它要判断的正是"写哪一层"。
  let home: string;
  let root: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-theme-home-'));
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-theme-root-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });
  const read = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;

  it('项目层没写 theme 时落全局;default 删掉键', async () => {
    expect(await saveTheme('dusk', root)).toBe(globalConfigPath());
    expect(await read(globalConfigPath())).toEqual({ theme: 'dusk' });
    await saveTheme(undefined, root);
    expect(await read(globalConfigPath())).toEqual({});
  });

  it('项目层已写 theme 时改项目层——否则下次启动会被项目层盖回去', async () => {
    const project = projectConfigPath(root);
    await fs.mkdir(path.dirname(project), { recursive: true });
    await fs.writeFile(project, JSON.stringify({ theme: 'old', timeline: 'compact' }));
    await fs.mkdir(path.dirname(globalConfigPath()), { recursive: true });
    await fs.writeFile(globalConfigPath(), JSON.stringify({ language: 'en' }));

    expect(await saveTheme('dusk', root)).toBe(project);
    expect(await read(project)).toEqual({ theme: 'dusk', timeline: 'compact' });
    expect(await read(globalConfigPath())).toEqual({ language: 'en' });
    await saveTheme(undefined, root);
    expect(await read(project)).toEqual({ timeline: 'compact' });
  });

  it('default 时两层都删——只删项目层会让全局层的值浮上来', async () => {
    const project = projectConfigPath(root);
    await fs.mkdir(path.dirname(project), { recursive: true });
    await fs.writeFile(project, JSON.stringify({ theme: 'night' }));
    await fs.mkdir(path.dirname(globalConfigPath()), { recursive: true });
    await fs.writeFile(globalConfigPath(), JSON.stringify({ theme: 'dusk', language: 'en' }));

    await saveTheme(undefined, root);
    expect(await read(project)).toEqual({});
    expect(await read(globalConfigPath())).toEqual({ language: 'en' });
  });
});
