/**
 * parsePlanSteps:checkbox / 编号行解析与回退语义(解析不出返回 undefined,
 * 调用方回退 Markdown 整渲染——回退路径必须锁住,不能白屏)。
 */

import { describe, expect, it } from 'vitest';
import { parsePlanSteps } from '../src/renderer/utils/plan-steps.js';

describe('parsePlanSteps', () => {
  it('checkbox 列表:勾选状态解析', () => {
    const steps = parsePlanSteps('# 计划\n- [x] 已完成的步骤\n- [ ] 待办步骤\n');
    expect(steps).toEqual([
      { text: '已完成的步骤', done: true },
      { text: '待办步骤', done: false },
    ]);
  });

  it('编号行:全部按未完成', () => {
    const steps = parsePlanSteps('1. 第一步\n2. 第二步\n3) 第三步\n');
    expect(steps).toHaveLength(3);
    expect(steps![0]).toEqual({ text: '第一步', done: false });
  });

  it('回退:纯段落 / 单条列表都返回 undefined', () => {
    expect(parsePlanSteps('就是一段说明文字,没有结构。')).toBeUndefined();
    expect(parsePlanSteps('说明:\n- [ ] 只有一条')).toBeUndefined();
    expect(parsePlanSteps('')).toBeUndefined();
  });
});
