/**
 * GUI i18n 双目录 parity(照根仓库 tests/i18n.test.ts 的思路):键集合必须
 * 一致,漏翻在编译期(detect 的 Record 类型)与运行期(此测试)双保险。
 */

import { describe, expect, it } from 'vitest';
import { en } from '../src/renderer/i18n/en.js';
import { zhCN } from '../src/renderer/i18n/zh-CN.js';

describe('i18n parity', () => {
  it('zh-CN 与 en 键集合一致', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  });

  it('目录值不为空串', () => {
    for (const [key, value] of Object.entries(en)) expect(value.length > 0, key).toBe(true);
    for (const [key, value] of Object.entries(zhCN)) expect(value.length > 0, key).toBe(true);
  });
});
