/**
 * bash 工具的流式输出(tool-output-delta):节流聚合、总量封顶、tool-end
 * 全量兜底。gate 全放行的 stub ToolContext,真实跑 node 子进程。
 */

import { describe, expect, it } from 'vitest';
import { EventBus, type AgentEvent } from '../src/core/events.js';
import { createBashTool } from '../src/tools/bash.js';
import type { ToolContext } from '../src/tools/context.js';

type Execute = (input: Record<string, unknown>, options: unknown) => Promise<Record<string, unknown>>;
const executeOf = (tool: unknown): Execute => (tool as { execute: Execute }).execute;

function makeCtx(): { ctx: ToolContext; deltas: Array<{ callId: string; chunk: string }> } {
  const bus = new EventBus();
  const deltas: Array<{ callId: string; chunk: string }> = [];
  bus.on((event: AgentEvent) => {
    if (event.type === 'tool-output-delta') deltas.push({ callId: event.callId, chunk: event.chunk });
  });
  const ctx = {
    root: process.cwd(),
    bus,
    gate: { checkBash: async () => {} },
    rules: { denyPath: [] },
  } as unknown as ToolContext;
  return { ctx, deltas };
}

describe('bash 流式输出', () => {
  it('增量到达且被聚合(条数远小于行数),tool 结果 output 完整', async () => {
    const { ctx, deltas } = makeCtx();
    const bash = createBashTool(ctx);
    // 200 行、分批输出:节流(100ms/2KB)应把它们合并成少量 delta。
    // 注意 shell 引号:外层单引号,脚本内不用反引号(会被 shell 当命令替换)。
    const script = 'for (let i = 0; i < 200; i++) process.stdout.write("line-" + i + "\\n");';
    const result = await executeOf(bash)(
      { command: `node -e '${script}'` },
      { abortSignal: undefined, toolCallId: 'call-1' },
    );

    expect(result.exitCode).toBe(0);
    const output = result.output as string;
    expect(output).toContain('line-0');
    expect(output).toContain('line-199');

    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(deltas.length).toBeLessThan(50); // 200 行绝不该 200 条事件
    expect(deltas.every((d) => d.callId === 'call-1')).toBe(true);
    // 拼起来就是完整输出(总量未超封顶时不丢字节)。
    expect(deltas.map((d) => d.chunk).join('')).toContain('line-199');
  });

  it('单次调用总发射量封顶 64KB,尾部由 tool-end 全量 output 兜底', async () => {
    const { ctx, deltas } = makeCtx();
    const bash = createBashTool(ctx);
    // 输出 ~200KB:delta 总量必须停在 64KB 附近,工具结果照常(truncate 20k)。
    const script = 'process.stdout.write("x".repeat(200000));';
    const result = await executeOf(bash)(
      { command: `node -e '${script}'` },
      { abortSignal: undefined, toolCallId: 'call-2' },
    );

    expect(result.exitCode).toBe(0);
    const total = deltas.reduce((sum, d) => sum + d.chunk.length, 0);
    expect(total).toBeLessThanOrEqual(64_000);
    expect(total).toBeGreaterThan(0);
  });

  it('无输出的命令不发任何 delta', async () => {
    const { ctx, deltas } = makeCtx();
    const bash = createBashTool(ctx);
    await executeOf(bash)({ command: 'true' }, { abortSignal: undefined, toolCallId: 'call-3' });
    expect(deltas).toEqual([]);
  });
});
