import { describe, expect, it, vi } from 'vitest';
import { PermissionDeniedError, PermissionGate } from '../src/permissions/gate.js';
import { EventBus, type PermissionDecision } from '../src/core/events.js';
import type { PermissionMode } from '../src/config/schema.js';

function makeGate(mode: PermissionMode, decision: PermissionDecision = { type: 'allow' }) {
  const ask = vi.fn(async () => decision);
  const gate = new PermissionGate({
    root: '/tmp/does-not-matter',
    mode,
    rules: { allowBash: [], denyBash: [], allowWrite: [], denyPath: [] },
    ask,
    bus: new EventBus(),
  });
  return { gate, ask };
}

describe('PermissionGate', () => {
  it('refuses every mutation in readonly mode without asking', async () => {
    const { gate, ask } = makeGate('readonly');
    expect(() => gate.assertCanMutate('src/a.ts')).toThrow(PermissionDeniedError);
    await expect(gate.checkWrite('src/a.ts')).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(gate.checkBash('npm install', '.')).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(ask).not.toHaveBeenCalled();
  });

  it('still allows read-only commands in readonly mode', async () => {
    const { gate, ask } = makeGate('readonly');
    await expect(gate.checkBash('git status', '.')).resolves.toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  it('prompts for writes in ask mode', async () => {
    const { gate, ask } = makeGate('ask');
    await gate.checkWrite('src/a.ts', 'diff');
    expect(ask).toHaveBeenCalledOnce();
  });

  it('skips the prompt for writes in acceptEdits, but not for shell', async () => {
    const { gate, ask } = makeGate('acceptEdits');
    await gate.checkWrite('src/a.ts');
    expect(ask).not.toHaveBeenCalled();
    await gate.checkBash('npm install lodash', '.');
    expect(ask).toHaveBeenCalledOnce();
  });

  it('turns a denial into an error the model can read', async () => {
    const { gate } = makeGate('ask', { type: 'deny' });
    await expect(gate.checkWrite('src/a.ts')).rejects.toThrow(/denied/i);
  });

  it('stops asking after allow-always for a matching path', async () => {
    const { gate, ask } = makeGate('ask', { type: 'allow-always', rule: 'src/**' });
    await gate.checkWrite('src/a.ts');
    expect(ask).toHaveBeenCalledOnce();
    await gate.checkWrite('src/nested/b.ts');
    expect(ask).toHaveBeenCalledOnce(); // 被记住的规则覆盖
    await gate.checkWrite('other/c.ts');
    expect(ask).toHaveBeenCalledTimes(2); // 在规则之外,所以再次询问
  });

  it('remembers an allowed bash prefix for the session', async () => {
    const { gate, ask } = makeGate('ask', { type: 'allow-always', rule: 'Bash(npm install:*)' });
    await gate.checkBash('npm install lodash', '.');
    expect(ask).toHaveBeenCalledOnce();
    await gate.checkBash('npm install react', '.');
    expect(ask).toHaveBeenCalledOnce();
  });

  it('refuses hard-denied commands even after the user allowed the prefix', async () => {
    const { gate } = makeGate('ask', { type: 'allow-always', rule: 'Bash(git:*)' });
    await expect(gate.checkBash('git push --force', '.')).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('allows everything in yolo mode, including the denylist', async () => {
    const { gate, ask } = makeGate('yolo');
    await expect(gate.checkBash('rm -rf build', '.')).resolves.toBeUndefined();
    await expect(gate.checkWrite('src/a.ts')).resolves.toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  it('always prompts for opaque MCP tools outside yolo', async () => {
    const { gate, ask } = makeGate('acceptEdits');
    await gate.checkMcpTool('mcp__db__query', { sql: 'select 1' });
    expect(ask).toHaveBeenCalledOnce();
  });
});
