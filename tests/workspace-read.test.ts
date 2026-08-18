import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readWorkspaceFile } from '../src/app/workspace-read.js';

/**
 * GUI 文件预览读取器:reason 码语义 + sandbox 防线复用(拒 .env、密钥、
 * 软链逃逸)。失败一律返回而不抛——GUI 靠 reason 渲染灰态。
 */
describe('readWorkspaceFile', () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-wsread-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-wsread-out-'));
    await fs.writeFile(path.join(root, 'ok.ts'), 'export const x = 1;\n');
    await fs.writeFile(path.join(root, '.env'), 'SECRET=1\n');
    await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]));
    await fs.mkdir(path.join(root, 'sub'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside\n');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
    await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(600_000));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('正常读取:内容与大小就位', async () => {
    const result = await readWorkspaceFile(root, 'ok.ts');
    expect(result).toMatchObject({ ok: true, path: 'ok.ts', content: 'export const x = 1;\n' });
  });

  it('.env 命中 DEFAULT_DENY → denied', async () => {
    expect((await readWorkspaceFile(root, '.env')).reason).toBe('denied');
  });

  it('软链逃逸出工作区 → denied', async () => {
    expect((await readWorkspaceFile(root, 'escape.txt')).reason).toBe('denied');
  });

  it('配置的 denyPath 同样生效', async () => {
    expect((await readWorkspaceFile(root, 'ok.ts', ['ok.ts'])).reason).toBe('denied');
  });

  it('二进制 → binary;目录 → is-directory;缺失 → not-found;超大 → too-large', async () => {
    expect((await readWorkspaceFile(root, 'blob.bin')).reason).toBe('binary');
    expect((await readWorkspaceFile(root, 'sub')).reason).toBe('is-directory');
    expect((await readWorkspaceFile(root, 'missing.txt')).reason).toBe('not-found');
    const big = await readWorkspaceFile(root, 'big.txt');
    expect(big.reason).toBe('too-large');
    expect(big.size).toBe(600_000);
  });
});
