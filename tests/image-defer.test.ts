import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deferImagesForModel } from '../src/app/image-defer.js';
import { unwrapAttachments, type ImageAttachment } from '../src/app/attachments.js';

describe('deferImagesForModel', () => {
  let dir: string;
  let root: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-defer-dir-'));
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-defer-root-'));
  });
  afterAll(async () => {
    await Promise.allSettled([
      fs.rm(dir, { recursive: true, force: true }),
      fs.rm(root, { recursive: true, force: true }),
    ]);
  });

  const pasted = (data: string): ImageAttachment => ({
    mediaType: 'image/png',
    data,
    filename: 'clipboard-1.png',
  });

  it('粘贴图落盘,信封列出路径与 mediaType,返回的 images 为 undefined', async () => {
    const bytes = Buffer.from('fake-png-bytes');
    const result = await deferImagesForModel('看图', [pasted(bytes.toString('base64'))], {
      viewImageTool: true,
      imagesDir: dir,
    });

    expect(result.deferred).toBe(1);
    expect(result.images).toBeUndefined();
    expect(result.text).toContain('看图');
    expect(result.text).toContain('[Attached images, readable with the view_image tool]');
    const line = result.text.split('\n').find((l) => l.startsWith('- '))!;
    const saved = line.slice(2, line.indexOf(' ('));
    expect(saved.startsWith(dir)).toBe(true);
    expect(saved.endsWith('.png')).toBe(true);
    // 磁盘字节 = base64 解码
    expect(((await fs.readFile(saved)) as Buffer).equals(bytes)).toBe(true);
  });

  it('无视觉模型时信封换成"无法直接查看"的措辞', async () => {
    const result = await deferImagesForModel('看图', [pasted('AAA=')], {
      viewImageTool: false,
      imagesDir: dir,
    });
    expect(result.text).toContain('this model cannot view them directly');
    expect(result.text).not.toContain('view_image tool]');
  });

  it('@图(absolutePath)零拷贝引用原路径,不产生新文件', async () => {
    const before = await fs.readdir(dir);
    const result = await deferImagesForModel(
      '看图',
      [{ mediaType: 'image/png', data: '', filename: 'shot.png', absolutePath: '/w/shot.png' }],
      { viewImageTool: true, imagesDir: dir },
    );
    expect(result.text).toContain('- /w/shot.png (image/png)');
    expect(await fs.readdir(dir)).toEqual(before);
  });

  it('写盘失败只进 skipped 行,不抛错', async () => {
    // 目录被一个同名普通文件占住:mkdir 失败、writeFile 也失败。
    const blocker = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-defer-block-'));
    const fileAsDir = path.join(blocker, 'occupied');
    await fs.writeFile(fileAsDir, 'x');
    const result = await deferImagesForModel('看图', [pasted('AAA=')], {
      viewImageTool: true,
      imagesDir: fileAsDir,
    });
    expect(result.deferred).toBe(0);
    expect(result.text).toContain('[Skipped clipboard-1.png: could not save image]');
    await fs.rm(blocker, { recursive: true, force: true });
  });

  it('与 @附件信封叠加时 unwrapAttachments 仍还原用户原文', async () => {
    const expanded =
      '看这个\n\n[Attached files, referenced with @ in the message above]\n\n<file path="a.ts">\nx\n</file>';
    const result = await deferImagesForModel(expanded, [pasted('AAA=')], {
      viewImageTool: true,
      imagesDir: dir,
    });
    expect(unwrapAttachments(result.text)).toBe('看这个');
  });

  it('同秒多图互不覆盖', async () => {
    const result = await deferImagesForModel(
      '两图',
      [pasted(Buffer.from('one').toString('base64')), pasted(Buffer.from('two').toString('base64'))],
      { viewImageTool: true, imagesDir: dir },
    );
    const lines = result.text.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(2);
    expect(new Set(lines).size).toBe(2);
    expect(result.deferred).toBe(2);
  });
});
