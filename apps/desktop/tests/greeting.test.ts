/**
 * 空状态问候纯函数测试:时段边界(5/9/12/14/18/23)与 24 取模回绕。
 */

import { describe, expect, it } from 'vitest';
import { greetingKeyForHour } from '../src/renderer/utils/greeting.js';

describe('greetingKeyForHour', () => {
  it('边界落在正确的时段', () => {
    expect(greetingKeyForHour(0)).toBe('greet.night');
    expect(greetingKeyForHour(4)).toBe('greet.night');
    expect(greetingKeyForHour(5)).toBe('greet.morning');
    expect(greetingKeyForHour(8)).toBe('greet.morning');
    expect(greetingKeyForHour(9)).toBe('greet.forenoon');
    expect(greetingKeyForHour(11)).toBe('greet.forenoon');
    expect(greetingKeyForHour(12)).toBe('greet.noon');
    expect(greetingKeyForHour(13)).toBe('greet.noon');
    expect(greetingKeyForHour(14)).toBe('greet.afternoon');
    expect(greetingKeyForHour(17)).toBe('greet.afternoon');
    expect(greetingKeyForHour(18)).toBe('greet.evening');
    expect(greetingKeyForHour(22)).toBe('greet.evening');
    expect(greetingKeyForHour(23)).toBe('greet.night');
  });

  it('越界输入按 24 取模回绕', () => {
    expect(greetingKeyForHour(24)).toBe('greet.night');
    expect(greetingKeyForHour(25)).toBe('greet.night'); // 25 点 = 凌晨 1 点
    expect(greetingKeyForHour(29)).toBe('greet.morning'); // 29 点 = 早上 5 点
    expect(greetingKeyForHour(-1)).toBe('greet.night');
    expect(greetingKeyForHour(12.7)).toBe('greet.noon');
  });
});
