import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFileTools } from '../src/tools/files.js';
import type { ToolContext } from '../src/tools/context.js';

/**
 * write 工具的结果 diff:新建与覆写都要带 unified diff(对齐 edit),
 * GUI/TUI 才能用同一套渲染器;权限卡 detail 的形态不在此测。
 */
describe('write 工具结果携带 unified diff', () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-write-diff-'));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  type Execute = (input: Record<string, unknown>, options: unknown) => Promise<Record<string, unknown>>;
  const executeOf = (tool: unknown): Execute => (tool as { execute: Execute }).execute;

  function makeCtx(): ToolContext {
    return {
      root,
      gate: { assertCanMutate: () => {}, checkWrite: async () => {} },
      rules: { denyPath: [] },
      readFiles: new Set<string>(),
    } as unknown as ToolContext;
  }

  it('新建文件:结果 diff 是全新增的 unified diff', async () => {
    const { write } = createFileTools(makeCtx());
    const result = await executeOf(write)({ path: 'fresh.ts', content: 'line1\nline2\n' }, {});
    expect(result.created).toBe(true);
    expect(result.changed).toBe(true);
    const diff = result.diff as string;
    expect(diff).toContain('@@');
    expect(diff).toContain('+line1');
    expect(diff).toContain('+line2');
    expect(diff).not.toContain('-line1');
  });

  it('覆写文件:结果 diff 反映前后差异', async () => {
    const { write } = createFileTools(makeCtx());
    await executeOf(write)({ path: 'over.ts', content: 'old content\nkeep\n' }, {});
    const result = await executeOf(write)({ path: 'over.ts', content: 'new content\nkeep\n' }, {});
    expect(result.created).toBe(false);
    const diff = result.diff as string;
    expect(diff).toContain('@@');
    expect(diff).toContain('-old content');
    expect(diff).toContain('+new content');
  });

  it('内容相同的短路分支不带 diff', async () => {
    const { write } = createFileTools(makeCtx());
    await executeOf(write)({ path: 'same.ts', content: 'x\n' }, {});
    const result = await executeOf(write)({ path: 'same.ts', content: 'x\n' }, {});
    expect(result.changed).toBe(false);
    expect('diff' in result).toBe(false);
  });
});
