import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';

/**
 * 图片降采样。PNG 的解码/编码用 node:zlib 手写(零依赖),JPEG 走纯 JS 的
 * jpeg-js;缩放统一用盒式滤波。
 *
 * 为什么值得做:服务商本身就会把长边超过 1568px 的图缩到这个尺寸再送进
 * 模型,多传的像素既不提升识别效果,又要计入上传流量、写进会话文件、
 * 并在此后每一步重传。一张原生 Retina 截图(3024×1964,数 MB)缩到长边
 * 1568 后通常只剩几百 KB。
 *
 * 格式保持不变(PNG 进 PNG 出,JPEG 进 JPEG 出):截图里的文字经 JPEG 有损
 * 编码会起振铃,而照片转 PNG 会暴涨,两个方向的转换都得不偿失。GIF/WebP
 * 不处理。无法处理的一律原样返回——降采样是尽力而为的优化,绝不能成为
 * 附图失败的理由。
 */

const inflate = promisify(zlib.inflate);
const deflate = promisify(zlib.deflate);

/** 长边上限,取服务商侧的缩放阈值,超出部分是纯浪费。 */
export const MAX_IMAGE_DIMENSION = 1568;

/**
 * PNG 解码的像素总数上限(约 25MP = 100MB RGBA)。文件体积上限挡不住
 * zlib 高压缩比炸弹,解码路径的三份大分配(inflate 原始行、unfilter、
 * RGBA 缓冲)叠起来是像素数的十几倍,超限直接放弃降采样。
 */
const MAX_DECODE_PIXELS = 25_000_000;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface RawImage {
  mediaType: string;
  /** base64。 */
  data: string;
}

/**
 * 长边超过 `MAX_IMAGE_DIMENSION` 时等比缩小。任何环节不支持或出错都原样
 * 返回入参,调用方无需处理失败。
 */
export async function downscaleImage(image: RawImage): Promise<RawImage> {
  const isJpeg = image.mediaType === 'image/jpeg';
  if (image.mediaType !== 'image/png' && !isJpeg) return image;
  try {
    const source = Buffer.from(image.data, 'base64');
    const bitmap = isJpeg ? decodeJpegBitmap(source) : await decodePng(source);
    if (!bitmap) return image;
    const scale = MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1) return image;

    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const resized = resizeBox(bitmap, width, height);
    const encoded = isJpeg
      ? encodeJpeg({ width, height, data: resized.pixels }, JPEG_QUALITY).data
      : await encodePng(resized);
    // 极少数情况下重编码反而更大(小图、噪点图),那就留着原图。
    if (encoded.length >= source.length) return image;
    return { mediaType: image.mediaType, data: encoded.toString('base64') };
  } catch {
    return image;
  }
}

/** 重编码质量。80 在文字可读性与体积之间是常用的平衡点。 */
const JPEG_QUALITY = 80;

/**
 * 解码 JPEG 为 RGBA 位图。上限用于挡住"解压炸弹"——一张几十 KB 的 JPEG
 * 可以声明上亿像素,不设限会直接把进程撑爆。
 */
function decodeJpegBitmap(buffer: Buffer): Bitmap | undefined {
  const raw = decodeJpeg(buffer, {
    formatAsRGBA: true,
    useTArray: true,
    maxResolutionInMP: 100,
    maxMemoryUsageInMB: 512,
  });
  if (!raw.width || !raw.height) return undefined;
  return {
    width: raw.width,
    height: raw.height,
    pixels: Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength),
    // JPEG 没有 alpha 通道,解出来恒为不透明。
    hasAlpha: false,
  };
}

interface Bitmap {
  width: number;
  height: number;
  /** RGBA,每通道 8 位。 */
  pixels: Buffer;
  /** 是否存在非不透明像素——决定编码时用 RGB 还是 RGBA。 */
  hasAlpha: boolean;
}

/**
 * 解码 PNG 为 RGBA 位图。只支持 8 位、非隔行的灰度/RGB/带 alpha 变体
 * ——截图恒在此列;调色板(colorType 3)、16 位、Adam7 隔行一律返回
 * undefined 交由调用方放弃降采样。
 */
async function decodePng(buffer: Buffer): Promise<Bitmap | undefined> {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) return undefined;

    if (type === 'IHDR') {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      bitDepth = buffer[start + 8]!;
      colorType = buffer[start + 9]!;
      const interlace = buffer[start + 12]!;
      if (bitDepth !== 8 || interlace !== 0) return undefined;
      if (![0, 2, 4, 6].includes(colorType)) return undefined;
      if (width === 0 || height === 0) return undefined;
      // 解压炸弹闸门:文件体积有 5MB 上限,但 zlib 可把几百 KB 膨胀成几百
      // MP——inflate/unfilter/像素缓冲三份大分配叠加足以 OOM 整个进程。
      // 超限放弃降采样(原样交还调用方),绝不解码。
      if (width * height > MAX_DECODE_PIXELS) return undefined;
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4; // 跳过 CRC
  }

  if (colorType === -1 || idat.length === 0) return undefined;

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const raw = await inflate(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return undefined;

  const unfiltered = unfilter(raw, width, height, channels);
  const pixels = Buffer.alloc(width * height * 4);
  let hasAlpha = false;

  for (let i = 0; i < width * height; i++) {
    const src = i * channels;
    const dst = i * 4;
    let r: number;
    let g: number;
    let b: number;
    let a = 255;
    if (channels === 1) {
      r = g = b = unfiltered[src]!;
    } else if (channels === 2) {
      r = g = b = unfiltered[src]!;
      a = unfiltered[src + 1]!;
    } else if (channels === 3) {
      r = unfiltered[src]!;
      g = unfiltered[src + 1]!;
      b = unfiltered[src + 2]!;
    } else {
      r = unfiltered[src]!;
      g = unfiltered[src + 1]!;
      b = unfiltered[src + 2]!;
      a = unfiltered[src + 3]!;
    }
    if (a !== 255) hasAlpha = true;
    pixels[dst] = r;
    pixels[dst + 1] = g;
    pixels[dst + 2] = b;
    pixels[dst + 3] = a;
  }

  return { width, height, pixels, hasAlpha };
}

/** 逐行还原 PNG 的行滤波(None/Sub/Up/Average/Paeth)。 */
function unfilter(raw: Buffer, width: number, height: number, channels: number): Buffer {
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]!;
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[pos + x]!;
      const left = x >= channels ? out[rowStart + x - channels]! : 0;
      const up = y > 0 ? out[prevStart + x]! : 0;
      const upLeft = y > 0 && x >= channels ? out[prevStart + x - channels]! : 0;
      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          restored = value;
      }
      out[rowStart + x] = restored & 0xff;
    }
    pos += stride;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * 盒式滤波缩放:目标像素取源图对应矩形区域的平均值。缩小场景下它比
 * 双线性更干净——双线性只采 4 个点,大比例缩小时会丢字形笔画、出摩尔纹,
 * 而截图里的文字正是最需要保住的信息。
 */
function resizeBox(bitmap: Bitmap, width: number, height: number): Bitmap {
  const out = Buffer.alloc(width * height * 4);
  const xRatio = bitmap.width / width;
  const yRatio = bitmap.height / height;

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.min(bitmap.height, Math.max(y0 + 1, Math.ceil((y + 1) * yRatio)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(bitmap.width, Math.max(x0 + 1, Math.ceil((x + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * bitmap.width + sx) * 4;
          r += bitmap.pixels[i]!;
          g += bitmap.pixels[i + 1]!;
          b += bitmap.pixels[i + 2]!;
          a += bitmap.pixels[i + 3]!;
          n++;
        }
      }
      const dst = (y * width + x) * 4;
      out[dst] = Math.round(r / n);
      out[dst + 1] = Math.round(g / n);
      out[dst + 2] = Math.round(b / n);
      out[dst + 3] = Math.round(a / n);
    }
  }

  return { width, height, pixels: out, hasAlpha: bitmap.hasAlpha };
}

/** 编码为 8 位 PNG。全不透明时写 RGB(colorType 2),省掉整条 alpha 通道。 */
async function encodePng(bitmap: Bitmap): Promise<Buffer> {
  const channels = bitmap.hasAlpha ? 4 : 3;
  const stride = bitmap.width * channels;
  // 每行前置一个滤波类型字节;统一用 0(None),让 deflate 去做压缩。
  const raw = Buffer.alloc((stride + 1) * bitmap.height);
  for (let y = 0; y < bitmap.height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < bitmap.width; x++) {
      const src = (y * bitmap.width + x) * 4;
      const dst = rowStart + 1 + x * channels;
      raw[dst] = bitmap.pixels[src]!;
      raw[dst + 1] = bitmap.pixels[src + 1]!;
      raw[dst + 2] = bitmap.pixels[src + 2]!;
      if (channels === 4) raw[dst + 3] = bitmap.pixels[src + 3]!;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(bitmap.width, 0);
  ihdr.writeUInt32BE(bitmap.height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = bitmap.hasAlpha ? 6 : 2; // 颜色类型
  ihdr[10] = 0; // 压缩方法
  ihdr[11] = 0; // 滤波方法
  ihdr[12] = 0; // 非隔行

  const compressed = await deflate(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
