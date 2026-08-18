/**
 * tokenize 近似高亮:关键字/类型/字符串/数字/注释/函数名分类,CJK 行判据,
 * langOf 扩展名推断。
 */

import { describe, expect, it } from 'vitest';
import { hasCjk, langOf, tokenize } from '../src/renderer/utils/tokenize.js';

const kindsOf = (line: string, lang?: string): Array<[string, string]> =>
  tokenize(line, lang).map((token) => [token.t, token.kind]);

describe('tokenize', () => {
  it('TS:关键字/类型/字符串/数字/函数名', () => {
    const kinds = new Map(kindsOf('const n: number = f("hi") + 42;', 'ts'));
    expect(kinds.get('const')).toBe('kw');
    expect(kinds.get('number')).toBe('ty');
    expect(kinds.get('"hi"')).toBe('str');
    expect(kinds.get('42')).toBe('num');
    expect(kinds.get('f')).toBe('fn');
  });

  it('Go 关键字集按 lang 切换;注释整段 cm', () => {
    const goKinds = new Map(kindsOf('func main() // entry', 'go'));
    expect(goKinds.get('func')).toBe('kw');
    expect(goKinds.get('// entry')).toBe('cm');
    // 同一行按 TS 集解析时 func 不是关键字。
    expect(new Map(kindsOf('func main()', 'ts')).get('func')).toBe('id');
  });

  it('拼接回原文(不丢字节)', () => {
    const line = '  if (x >= 10) { return "ok"; }';
    expect(tokenize(line, 'ts').map((token) => token.t).join('')).toBe(line);
  });

  it('hasCjk 判据与 langOf 扩展名', () => {
    expect(hasCjk('读取 120 行')).toBe(true);
    expect(hasCjk('read 120 lines')).toBe(false);
    expect(langOf('src/a.go')).toBe('go');
    expect(langOf('b.py')).toBe('python');
    expect(langOf('noext')).toBeUndefined();
  });
});
