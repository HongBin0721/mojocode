import { describe, expect, it } from 'vitest';
import { parseOsascriptData } from '../src/app/clipboard.js';

describe('parseOsascriptData', () => {
  it('解析 osascript 的 «data PNGf<hex>» 输出为 base64', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const stdout = `«data PNGf${bytes.toString('hex').toUpperCase()}»\n`;
    expect(parseOsascriptData(stdout, 'image/png')).toEqual({
      mediaType: 'image/png',
      data: bytes.toString('base64'),
    });
  });

  it('非 data 输出(剪贴板是文字)返回 undefined', () => {
    expect(parseOsascriptData('hello world', 'image/png')).toBeUndefined();
    expect(parseOsascriptData('', 'image/png')).toBeUndefined();
  });

  it('奇数长度的 hex(截断输出)返回 undefined', () => {
    expect(parseOsascriptData('«data PNGf895»', 'image/png')).toBeUndefined();
  });
});
