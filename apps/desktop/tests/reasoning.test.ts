/**
 * 思考强度菜单纯函数测试:条目序 = schema 声明序,当前档打标,RPC 组装。
 */

import { describe, expect, it } from 'vitest';
import { REASONING_EFFORTS } from '@core/schema';
import { reasoningMenuEntries, setReasoningRpc } from '../src/renderer/commands/reasoning.js';

describe('reasoning menu', () => {
  it('条目序与 schema 声明序一致,当前档打标', () => {
    const entries = reasoningMenuEntries('high');
    expect(entries.map((e) => e.level)).toEqual([...REASONING_EFFORTS]);
    expect(entries.filter((e) => e.current).map((e) => e.level)).toEqual(['high']);
    // 非法值(不该出现)不会命中任何 current。
    expect(reasoningMenuEntries('auto' as never).find((e) => e.current)?.level).toBe('auto');
  });

  it('RPC 组装:kind + level', () => {
    expect(setReasoningRpc('max')).toEqual({ kind: 'setReasoningEffort', level: 'max' });
    expect(setReasoningRpc('off')).toEqual({ kind: 'setReasoningEffort', level: 'off' });
  });
});
