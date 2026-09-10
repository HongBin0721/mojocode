import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  deleteProviderEntry,
  saveApiKey,
  saveCustomProvider,
  saveProviderEntry,
  saveReasoningEffort,
  setDefaultProvider,
} from '../src/config/save.js';

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

describe('saveProviderEntry / deleteProviderEntry(GUI 模型设置)', () => {
  it('合并写入 patch 里的键,保留条目其余字段;models 整组替换', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        providers: { glm: { apiKey: 'g1', model: 'GLM-5.3', models: [{ id: 'GLM-5.2' }] } },
      }),
    );

    await saveProviderEntry(
      'glm',
      { models: [{ id: 'GLM-5.3', contextWindow: 1_000_000 }] },
      file,
    );

    expect(await readConfig()).toEqual({
      providers: {
        glm: {
          apiKey: 'g1',
          model: 'GLM-5.3',
          models: [{ id: 'GLM-5.3', contextWindow: 1_000_000 }],
        },
      },
    });
  });

  it('undefined 值不落盘——GUI 的脱敏副本不会覆盖真 key', async () => {
    await saveProviderEntry('glm', { apiKey: 'real', model: 'GLM-5.3' }, file);
    await saveProviderEntry('glm', { apiKey: undefined, label: 'GLM' }, file);
    expect(await readConfig()).toEqual({
      providers: { glm: { apiKey: 'real', model: 'GLM-5.3', label: 'GLM' } },
    });
  });

  it('deleteProviderEntry 整条移除,其他条目不动;文件不存在也不抛', async () => {
    await saveProviderEntry('a', { baseURL: 'https://a.example/v1' }, file);
    await saveProviderEntry('b', { baseURL: 'https://b.example/v1' }, file);
    await deleteProviderEntry('a', file);
    expect(await readConfig()).toEqual({ providers: { b: { baseURL: 'https://b.example/v1' } } });

    const fresh = path.join(dir, 'nested', 'fresh.json');
    await expect(deleteProviderEntry('nope', fresh)).resolves.toBe(fresh);
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
