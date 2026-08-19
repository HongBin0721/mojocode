/**
 * GUI 偏好落盘(main/gui-prefs.ts):读盘健壮性(坏 JSON/非对象/异构值)、
 * set→flush 的去抖落盘往返、IPC 入参的类型闸门。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGuiPrefs, loadGuiPrefs } from '../src/main/gui-prefs.js';

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'gui-prefs-'));
  dirs.push(dir);
  return dir;
};
// 落在不存在的子目录里:顺带验证写入路径的 mkdir -p。
const tempFile = (): string => join(tempDir(), 'nested', 'gui.json');

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadGuiPrefs', () => {
  it('不存在的文件回空对象', () => {
    expect(loadGuiPrefs(tempFile())).toEqual({});
  });

  it('坏 JSON / 非对象 / 数组一律回空对象', () => {
    for (const raw of ['{oops', '"str"', '[1,2]', 'null']) {
      const file = join(tempDir(), 'gui.json');
      writeFileSync(file, raw);
      expect(loadGuiPrefs(file)).toEqual({});
    }
  });

  it('非字符串值被丢弃,字符串值保留', () => {
    const file = join(tempDir(), 'gui.json');
    writeFileSync(file, JSON.stringify({ a: '1', b: 2, c: null, d: ['x'] }));
    expect(loadGuiPrefs(file)).toEqual({ a: '1' });
  });
});

describe('createGuiPrefs', () => {
  it('set → flush 落盘,重开可读回', () => {
    const file = tempFile();
    const prefs = createGuiPrefs(file);
    prefs.set('mojocode.projects', '["/a","/b"]');
    prefs.set('mojocode.locale', 'zh-CN');
    prefs.flush();
    expect(loadGuiPrefs(file)).toEqual({
      'mojocode.projects': '["/a","/b"]',
      'mojocode.locale': 'zh-CN',
    });
    expect(createGuiPrefs(file).snapshot()).toEqual({
      'mojocode.projects': '["/a","/b"]',
      'mojocode.locale': 'zh-CN',
    });
  });

  it('snapshot 是副本:改它不污染内部状态', () => {
    const file = tempFile();
    const prefs = createGuiPrefs(file);
    prefs.set('k', 'v');
    const snap = prefs.snapshot();
    snap['k'] = 'hacked';
    expect(prefs.snapshot()['k']).toBe('v');
  });

  it('非字符串入参被拒(IPC 类型闸门)', () => {
    const file = tempFile();
    const prefs = createGuiPrefs(file);
    prefs.set('k', 42 as unknown as string);
    prefs.set(1 as unknown as string, 'v');
    prefs.flush();
    expect(loadGuiPrefs(file)).toEqual({});
  });

  it('无待写时 flush 不产生文件', () => {
    const file = tempFile();
    createGuiPrefs(file).flush();
    expect(() => readFileSync(file)).toThrow();
  });
});
