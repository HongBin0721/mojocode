/**
 * 思考强度菜单纯函数测试:条目序 = schema 声明序,当前档打标,RPC 组装。
 */

import { describe, expect, it } from 'vitest';
import { REASONING_EFFORTS } from '@core/schema';
import { reasoningMenuEntries, setReasoningRpc } from '../src/renderer/commands/reasoning.js';

describe('reasoning menu', () => {
  it('条目序与 schema 声明序一致,当前档打标;auto 永不列出', () => {
    const entries = reasoningMenuEntries('high');
    expect(entries.map((e) => e.level)).toEqual(REASONING_EFFORTS.filter((l) => l !== 'auto'));
    expect(entries.filter((e) => e.current).map((e) => e.level)).toEqual(['high']);
    // 当前档是 auto(初始默认态)时不列出、也不打标——chip 上的「自动」描述现状即可。
    expect(reasoningMenuEntries('auto').some((e) => e.level === 'auto')).toBe(false);
    expect(reasoningMenuEntries('auto').find((e) => e.current)).toBeUndefined();
  });

  it('传入可选档位(models.dev 能力)时收窄条目,当前档(非 auto)恒保留', () => {
    const entries = reasoningMenuEntries('medium', ['off', 'low', 'high', 'max']);
    // medium 不在可选集里,但它是当前档——藏掉会让 chip 与菜单对不上。
    expect(entries.map((e) => e.level)).toEqual(['off', 'low', 'medium', 'high', 'max']);
    const narrowed = reasoningMenuEntries('auto', ['off']);
    expect(narrowed.map((e) => e.level)).toEqual(['off']);
  });

  it('RPC 组装:kind + level', () => {
    expect(setReasoningRpc('max')).toEqual({ kind: 'setReasoningEffort', level: 'max' });
    expect(setReasoningRpc('off')).toEqual({ kind: 'setReasoningEffort', level: 'off' });
  });
});
