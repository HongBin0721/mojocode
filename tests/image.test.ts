import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { encode as encodeJpeg } from 'jpeg-js';
import { downscaleImage, MAX_IMAGE_DIMENSION } from '../src/app/image.js';

/**
 * 固件 PNG 用一段独立的最小编码器现造(滤波全 0、colorType 6),不复用被
 * 测模块的编码路径,免得解码器与编码器互相"对答案"。校验也只读 IHDR——
 * 那是 12 字节定长头,与被测代码无关。
 */
function makePng(width: number, height: number, color: (x: number, y: number) => number[]): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = color(x, y) as [number, number, number, number];
      const at = row + 1 + x * 4;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
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
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 只读 IHDR:签名 8 字节 + 长度 4 + 类型 4,宽高紧随其后。 */
function readSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function pixelAt(png: Buffer, x: number, y: number): number[] {
  // 解压 IDAT 自行还原(固件与输出都用滤波 0,无需实现 unfilter)。
  const { width } = readSize(png);
  const colorType = png[25]!;
  const channels = colorType === 6 ? 4 : 3;
  let offset = 8;
  const parts: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') parts.push(png.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += length + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const at = y * (stride + 1) + 1 + x * channels;
  expect(raw[y * (stride + 1)]).toBe(0); // 输出确实是 None 滤波
  return [raw[at]!, raw[at + 1]!, raw[at + 2]!];
}

const b64 = (buf: Buffer) => buf.toString('base64');

/** 独立解析 JPEG 的 SOF 段取宽高——不经过被测模块的解码路径。 */
function readJpegSize(buf: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return undefined;
}

/** 造一张渐变 JPEG(纯色会压得过小,盖不住"重编码后更大就留原图"的分支)。 */
function makeJpeg(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = (i * 7) % 256;
    data[i * 4 + 1] = (i * 13) % 256;
    data[i * 4 + 2] = (i * 29) % 256;
    data[i * 4 + 3] = 255;
  }
  return Buffer.from(encodeJpeg({ width, height, data }, 90).data);
}

describe('downscaleImage', () => {
  it('长边超限的 PNG 被等比缩到上限内', async () => {
    const png = makePng(3024, 1964, () => [10, 20, 30, 255]);
    const result = await downscaleImage({ mediaType: 'image/png', data: b64(png) });

    const out = Buffer.from(result.data, 'base64');
    const size = readSize(out);
    expect(size.width).toBe(MAX_IMAGE_DIMENSION);
    // 1964 * (1568/3024) ≈ 1018,等比不走形。
    expect(size.height).toBe(Math.round((1964 * MAX_IMAGE_DIMENSION) / 3024));
    expect(out.length).toBeLessThan(png.length);
    expect(result.mediaType).toBe('image/png');
  });

  it('长边未超限的图原样返回(逐字节相同)', async () => {
    const png = makePng(800, 600, () => [1, 2, 3, 255]);
    const data = b64(png);
    const result = await downscaleImage({ mediaType: 'image/png', data });
    expect(result.data).toBe(data);
  });

  it('缩放后颜色仍然正确(盒式滤波取区域均值)', async () => {
    // 左半红右半蓝:缩完后两侧应各自保持纯色,只有中缝混合。
    const png = makePng(3000, 100, (x) => (x < 1500 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const result = await downscaleImage({ mediaType: 'image/png', data: b64(png) });
    const out = Buffer.from(result.data, 'base64');
    const { width } = readSize(out);

    expect(pixelAt(out, 10, 0)).toEqual([255, 0, 0]);
    expect(pixelAt(out, width - 10, 0)).toEqual([0, 0, 255]);
  });

  it('全不透明的图编码为 RGB,省掉 alpha 通道', async () => {
    const png = makePng(2000, 100, () => [9, 9, 9, 255]);
    const result = await downscaleImage({ mediaType: 'image/png', data: b64(png) });
    const out = Buffer.from(result.data, 'base64');
    expect(out[25]).toBe(2); // colorType 2 = RGB
  });

  it('存在半透明像素时保留 alpha 通道', async () => {
    const png = makePng(2000, 100, (x) => [9, 9, 9, x === 0 ? 128 : 255]);
    const result = await downscaleImage({ mediaType: 'image/png', data: b64(png) });
    const out = Buffer.from(result.data, 'base64');
    expect(out[25]).toBe(6); // colorType 6 = RGBA
  });

  it('GIF/WebP 等其余格式原样返回', async () => {
    const gif = { mediaType: 'image/gif', data: 'AAAA' };
    expect(await downscaleImage(gif)).toEqual(gif);
  });

  it('长边超限的 JPEG 被等比缩小,格式保持 JPEG', async () => {
    const jpeg = makeJpeg(2400, 1200);
    const result = await downscaleImage({ mediaType: 'image/jpeg', data: b64(jpeg) });

    expect(result.mediaType).toBe('image/jpeg');
    const out = Buffer.from(result.data, 'base64');
    expect(readJpegSize(out)).toEqual({
      width: MAX_IMAGE_DIMENSION,
      height: Math.round((1200 * MAX_IMAGE_DIMENSION) / 2400),
    });
    expect(out.length).toBeLessThan(jpeg.length);
  });

  it('长边未超限的 JPEG 原样返回,不做有损重编码', async () => {
    const jpeg = makeJpeg(800, 400);
    const data = b64(jpeg);
    const result = await downscaleImage({ mediaType: 'image/jpeg', data });
    expect(result.data).toBe(data);
  });

  it('损坏的 JPEG 原样返回,不抛错', async () => {
    const broken = { mediaType: 'image/jpeg', data: b64(Buffer.from('\xff\xd8not really a jpeg')) };
    expect(await downscaleImage(broken)).toEqual(broken);
  });

  it('损坏/不支持的 PNG 原样返回,不抛错', async () => {
    const broken = { mediaType: 'image/png', data: b64(Buffer.from('not a png at all')) };
    expect(await downscaleImage(broken)).toEqual(broken);

    // 16 位深不在支持范围内(截图不会是这种),应放弃降采样而不是出错。
    const png = makePng(2000, 100, () => [1, 2, 3, 255]);
    png[24] = 16;
    const deep = { mediaType: 'image/png', data: b64(png) };
    expect(await downscaleImage(deep)).toEqual(deep);
  });
});
