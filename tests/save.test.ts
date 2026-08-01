import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveApiKey, setDefaultProvider } from '../src/config/save.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kdg-save-'));
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
