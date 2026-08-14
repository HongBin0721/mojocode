import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveApiKey, saveCustomProvider, savePermissions, saveReasoningEffort, setDefaultProvider } from '../src/config/save.js';
import { presetById } from '../src/config/schema.js';

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
      JSON.stringify({ providers: { glm: { apiKey: 'old', model: 'glm-5' } } }),
    );

    await saveApiKey('glm', 'new', { file });
    expect(await readConfig()).toEqual({ providers: { glm: { apiKey: 'new', model: 'glm-5' } } });
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
        providers: { glm: { apiKey: 'g1', model: 'glm-5' } },
      }),
    );

    await saveReasoningEffort('glm', 'high', file);

    expect(await readConfig()).toEqual({
      reasoningEffort: 'low',
      providers: { glm: { apiKey: 'g1', model: 'glm-5', reasoningEffort: 'high' } },
    });
  });

  it('creates the providers entry when missing', async () => {
    await saveReasoningEffort('kimi', 'max', file);
    expect(await readConfig()).toEqual({ providers: { kimi: { reasoningEffort: 'max' } } });
  });
});

describe('savePermissions', () => {
  it('写项目配置而不是全局配置,放宽不会泄漏到其他工作区', async () => {
    const saved = await savePermissions(dir, presetById('auto'), file);

    expect(saved).toBe(file);
    expect(await readConfig()).toEqual({ sandbox: 'workspace-write', approval: 'on-request' });
  });

  it('默认落在 <root>/.mojocode/config.json', async () => {
    const saved = await savePermissions(dir, presetById('read-only'));

    expect(saved).toBe(path.join(dir, '.mojocode', 'config.json'));
    expect(JSON.parse(await fs.readFile(saved, 'utf8'))).toEqual({
      sandbox: 'read-only',
      approval: 'on-request',
    });
  });

  // 用户显式选的档位一律留存,full-access 也不例外(它绕过硬拒名单,代价是
  // 选中它的每条路径都要在时间线上留警告——见 App 的 applyMode)。
  it('full-access 同样落盘', async () => {
    expect(await savePermissions(dir, presetById('full-access'), file)).toBe(file);
    expect(await readConfig()).toEqual({ sandbox: 'danger-full-access', approval: 'never' });
  });

  it('保留项目配置里已有的权限规则,并顺带清掉旧版 permissionMode', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ permissionMode: 'ask', permissions: { allowBash: ['git status'] } }),
    );

    await savePermissions(dir, presetById('auto'), file);

    expect(await readConfig()).toEqual({
      permissions: { allowBash: ['git status'] },
      sandbox: 'workspace-write',
      approval: 'on-request',
    });
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
