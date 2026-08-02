import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  expandAtReferences,
  extractAtPaths,
  unwrapAttachments,
  warnableSkips,
} from '../src/app/attachments.js';

describe('extractAtPaths', () => {
  it('提取行首与句中的 @路径,按出现顺序去重', () => {
    expect(extractAtPaths('@a.ts 和 @b.ts 再看 @a.ts')).toEqual(['a.ts', 'b.ts']);
  });

  it('@ 前不是空白时不算引用(邮箱等)', () => {
    expect(extractAtPaths('联系 foo@bar.com')).toEqual([]);
  });

  it('剥掉尾部标点(含中文标点)', () => {
    expect(extractAtPaths('看看 @src/app.ts, 以及 @README.md。')).toEqual([
      'src/app.ts',
      'README.md',
    ]);
  });

  it('换行后的 @ 同样触发', () => {
    expect(extractAtPaths('第一行\n@x.ts')).toEqual(['x.ts']);
  });
});

describe('expandAtReferences / unwrapAttachments', () => {
  let root: string;

  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-attach-'));
    await fs.writeFile(path.join(root, 'hello.ts'), 'export const hi = 1;\n');
    await fs.writeFile(path.join(root, '.env'), 'SECRET=x\n');
    await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(65 * 1024));
    await fs.writeFile(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 0]));
    await fs.mkdir(path.join(root, 'sub'));
    await fs.writeFile(path.join(root, 'img.png'), PNG_BYTES);
    await fs.writeFile(path.join(root, 'huge.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
    await fs.writeFile(path.join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('附上文件内容,原文在前,信封可被 unwrap 还原', async () => {
    const text = '解释一下 @hello.ts';
    const result = await expandAtReferences(text, { root });
    expect(result.attached).toEqual(['hello.ts']);
    expect(result.skipped).toEqual([]);
    expect(result.expanded.startsWith(text)).toBe(true);
    expect(result.expanded).toContain('<file path="hello.ts">');
    expect(result.expanded).toContain('export const hi = 1;');
    expect(unwrapAttachments(result.expanded)).toBe(text);
  });

  it('不存在的文件进 skipped,不抛错', async () => {
    const result = await expandAtReferences('看 @missing.ts', { root });
    expect(result.expanded).toBe('看 @missing.ts');
    expect(result.skipped).toEqual([{ path: 'missing.ts', reason: 'not found' }]);
  });

  it('sandbox 拒绝的路径(.env、越界)进 skipped', async () => {
    const result = await expandAtReferences('看 @.env 和 @../outside.ts', { root });
    expect(result.attached).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      'blocked by workspace rules',
      'blocked by workspace rules',
    ]);
  });

  it('目录、二进制、超限文件各有原因', async () => {
    const result = await expandAtReferences('@sub @bin.dat @big.txt', { root });
    expect(result.attached).toEqual([]);
    expect(result.skipped).toEqual([
      { path: 'sub', reason: 'is a directory' },
      { path: 'bin.dat', reason: 'binary file' },
      expect.objectContaining({ path: 'big.txt' }),
    ]);
    expect(result.skipped[2]!.reason).toMatch(/too large/);
  });

  it('部分成功时,跳过的引用也写进信封告知模型', async () => {
    const result = await expandAtReferences('@hello.ts @missing.ts', { root });
    expect(result.attached).toEqual(['hello.ts']);
    expect(result.expanded).toContain('[Skipped @missing.ts: not found]');
    expect(unwrapAttachments(result.expanded)).toBe('@hello.ts @missing.ts');
  });

  it('没有 @ 引用时原样返回,expanded 严格相等', async () => {
    const result = await expandAtReferences('普通消息', { root });
    expect(result.expanded).toBe('普通消息');
    expect(result.attached).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('非信封文本 unwrap 返回 undefined', () => {
    expect(unwrapAttachments('普通消息')).toBeUndefined();
  });

  // `@types/node`、`@某人` 这类普通行文天然落在 not found 上,不该报警。
  it('没有任何引用解析成功时,not found 不值得提示', async () => {
    const result = await expandAtReferences('看下 @types/node 的用法', { root });
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(warnableSkips(result)).toEqual([]);
  });

  it('确有引用解析成功时,打错的路径要提示', async () => {
    const result = await expandAtReferences('@hello.ts 和 @typo.ts', { root });
    expect(warnableSkips(result)).toEqual([{ path: 'typo.ts', reason: 'not found' }]);
  });

  it('非 not found 的原因一律提示,哪怕没有引用成功', async () => {
    const result = await expandAtReferences('@.env', { root });
    expect(warnableSkips(result)).toEqual([
      { path: '.env', reason: 'blocked by workspace rules' },
    ]);
  });

  it('@图片附成 images,不进文本信封,expanded 与原文相等', async () => {
    const text = '看这张图 @img.png';
    const result = await expandAtReferences(text, { root });
    expect(result.expanded).toBe(text);
    expect(result.attached).toEqual(['img.png']);
    expect(result.images).toEqual([
      { mediaType: 'image/png', data: PNG_BYTES.toString('base64'), filename: 'img.png' },
    ]);
  });

  // 与 tests/image.test.ts 的单元测试互补:确认 @ 引用这条链路确实接上了
  // 降采样,而不是只在剪贴板那一侧生效。
  it('@ 引用的大尺寸 PNG 会被降采样后再附上', async () => {
    const wide = path.join(root, 'wide.png');
    const stride = 3000 * 4;
    const raw = Buffer.alloc((stride + 1) * 10); // 3000x10,全透明黑,滤波 0
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(3000, 0);
    ihdr.writeUInt32BE(10, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    const chunk = (type: string, data: Buffer) => {
      const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      let c = 0xffffffff;
      for (const byte of body) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
      const out = Buffer.alloc(12 + data.length);
      out.writeUInt32BE(data.length, 0);
      body.copy(out, 4);
      out.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + data.length);
      return out;
    };
    await fs.writeFile(
      wide,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
      ]),
    );

    const result = await expandAtReferences('@wide.png', { root });
    expect(result.images).toHaveLength(1);
    const out = Buffer.from(result.images[0]!.data, 'base64');
    expect(out.readUInt32BE(16)).toBe(1568); // 宽已缩到上限
  });

  it('超过 5MB 的图片进 skipped', async () => {
    const result = await expandAtReferences('@huge.png', { root });
    expect(result.images).toEqual([]);
    expect(result.skipped[0]!.reason).toMatch(/image too large/);
  });

  it('SVG 走文本路径而不是图片', async () => {
    const result = await expandAtReferences('@icon.svg', { root });
    expect(result.images).toEqual([]);
    expect(result.expanded).toContain('<file path="icon.svg">');
  });

  it('文本与图片混合引用:文本进信封、图片进 images,unwrap 还原原文', async () => {
    const text = '@hello.ts 和 @img.png';
    const result = await expandAtReferences(text, { root });
    expect(result.expanded).toContain('<file path="hello.ts">');
    expect(result.images.map((i) => i.filename)).toEqual(['img.png']);
    expect(unwrapAttachments(result.expanded)).toBe(text);
  });
});
