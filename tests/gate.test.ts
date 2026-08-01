import { describe, expect, it, vi } from 'vitest';
import { PermissionDeniedError, PermissionGate } from '../src/permissions/gate.js';
import { EventBus, type PermissionDecision, type PermissionRequest } from '../src/core/events.js';
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

describe('会话规则导出/导入(跨恢复还原)', () => {
  it('export/import 往返后规则依旧生效,且导入去重', async () => {
    const { gate, ask } = makeGate('ask', { type: 'allow-always', rule: 'Bash(npm install:*)' });
    await gate.checkBash('npm install lodash', '.');
    expect(ask).toHaveBeenCalledOnce();

    const exported = gate.exportSessionRules();
    expect(exported.allowBash).toEqual(['Bash(npm install:*)']);
    // 返回副本:改动导出结果不应影响 gate 内部状态。
    exported.allowBash.push('Bash(rm:*)');
    expect(gate.exportSessionRules().allowBash).toEqual(['Bash(npm install:*)']);

    // 恢复到一个新 gate:导入后同类命令不再询问。
    const restored = makeGate('ask');
    restored.gate.setSessionRules({ allowBash: ['Bash(npm install:*)'], allowWrite: ['src/**'] });
    restored.gate.setSessionRules({ allowBash: ['Bash(npm install:*)'], allowWrite: ['src/**'] }); // 去重
    await restored.gate.checkBash('npm install react', '.');
    await restored.gate.checkWrite('src/a.ts');
    expect(restored.ask).not.toHaveBeenCalled();
    expect(restored.gate.exportSessionRules()).toEqual({
      allowBash: ['Bash(npm install:*)'],
      allowWrite: ['src/**'],
    });
  });

  it('setSessionRules 是替换而非追加:切会话不会把上一段的授权带过去', async () => {
    const { gate, ask } = makeGate('ask', { type: 'allow-always', rule: 'Bash(npm install:*)' });
    await gate.checkBash('npm install lodash', '.');
    expect(gate.exportSessionRules().allowBash).toEqual(['Bash(npm install:*)']);

    // /resume 切到另一个会话:它自己的规则完全取代前一段的。
    gate.setSessionRules({ allowBash: ['Bash(git:*)'], allowWrite: [] });
    expect(gate.exportSessionRules()).toEqual({ allowBash: ['Bash(git:*)'], allowWrite: [] });

    // 上一段批准过的命令必须重新询问,否则授权跨会话泄漏。
    ask.mockClear();
    await gate.checkBash('npm install react', '.');
    expect(ask).toHaveBeenCalledOnce();
  });

  it('remember 触发 onRulesChanged,导入不触发', async () => {
    const onRulesChanged = vi.fn();
    const gate = new PermissionGate({
      root: '/tmp/does-not-matter',
      mode: 'ask',
      rules: { allowBash: [], denyBash: [], allowWrite: [], denyPath: [] },
      ask: async () => ({ type: 'allow-always', rule: 'src/**' }),
      bus: new EventBus(),
      onRulesChanged,
    });
    gate.setSessionRules({ allowBash: ['Bash(git:*)'], allowWrite: [] });
    expect(onRulesChanged).not.toHaveBeenCalled();
    await gate.checkWrite('src/a.ts');
    expect(onRulesChanged).toHaveBeenCalledOnce();
  });
});

describe('并行工具调用的授权排队', () => {
  /** 手动控制每次询问何时决定,模拟用户逐个操作确认框。 */
  function makeQueuedGate() {
    const asked: PermissionRequest[] = [];
    const resolvers: Array<(d: PermissionDecision) => void> = [];
    const events: PermissionRequest[] = [];
    const bus = new EventBus();
    bus.on((e) => {
      if (e.type === 'permission-request') events.push(e.request);
    });
    const gate = new PermissionGate({
      root: '/tmp/does-not-matter',
      mode: 'ask',
      rules: { allowBash: [], denyBash: [], allowWrite: [], denyPath: [] },
      ask: async (req) => {
        asked.push(req);
        return new Promise<PermissionDecision>((resolve) => resolvers.push(resolve));
      },
      bus,
    });
    return { gate, asked, resolvers, events };
  }

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('一次只呈现一个确认框,前一个决定后才问下一个', async () => {
    const { gate, asked, resolvers, events } = makeQueuedGate();

    // 两个工具并行申请授权——界面一次只放得下一个。
    const first = gate.checkWrite('src/a.ts');
    const second = gate.checkWrite('src/b.ts');
    await settle();

    expect(asked).toHaveLength(1);
    // 事件也必须排队:提前发出会让 UI 被后来的请求顶掉当前确认框。
    expect(events).toHaveLength(1);
    expect(asked[0]!.title).toContain('a.ts');

    resolvers[0]!({ type: 'allow' });
    await first;
    await settle();

    expect(asked).toHaveLength(2);
    expect(events).toHaveLength(2);
    expect(asked[1]!.title).toContain('b.ts');

    resolvers[1]!({ type: 'allow' });
    await expect(second).resolves.toBeUndefined();
  });

  it('先到的请求不会被后到的顶掉而永远悬着', async () => {
    const { gate, resolvers } = makeQueuedGate();

    const first = gate.checkWrite('src/a.ts');
    const second = gate.checkWrite('src/b.ts');
    await settle();

    // 逐个决定,两个 promise 都要有结果——排队之前先到的那个会永远挂起。
    resolvers[0]!({ type: 'allow' });
    await settle();
    resolvers[1]!({ type: 'allow' });

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it('轮中断后,排队中的请求自动拒绝而不再弹给用户', async () => {
    const { gate, asked, resolvers, events } = makeQueuedGate();

    const first = gate.checkWrite('src/a.ts');
    // 立刻挂上处理器:这两个会在断言之前就被拒绝,否则报成 unhandled rejection。
    const second = gate.checkWrite('src/b.ts').catch((err: Error) => err);
    const third = gate.checkBash('npm install lodash', '.').catch((err: Error) => err);
    await settle();
    expect(asked).toHaveLength(1);

    // 用户中断整轮,然后把当前这个确认框决定掉。
    gate.cancelPending();
    resolvers[0]!({ type: 'allow' });
    await first;
    await settle();

    // 队列里剩下的两个不再询问、也不再发事件,直接以拒绝收场——
    // 若继续弹出,用户批准时 write/edit 会真的写盘(它们不接 abortSignal)。
    expect(asked).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(await second).toBeInstanceOf(PermissionDeniedError);
    expect(await third).toBeInstanceOf(PermissionDeniedError);

    // 新一轮开始后恢复正常询问。
    gate.resumePending();
    const next = gate.checkWrite('src/c.ts');
    await settle();
    expect(asked).toHaveLength(2);
    resolvers[1]!({ type: 'allow' });
    await expect(next).resolves.toBeUndefined();
  });

  it('一次拒绝不会毒化排在后面的请求', async () => {
    const { gate, resolvers } = makeQueuedGate();

    const first = gate.checkWrite('src/a.ts');
    const second = gate.checkWrite('src/b.ts');
    await settle();

    resolvers[0]!({ type: 'deny' });
    await expect(first).rejects.toBeInstanceOf(PermissionDeniedError);
    await settle();

    // 队列继续推进,后面的请求照常拿到自己的确认框。
    expect(resolvers).toHaveLength(2);
    resolvers[1]!({ type: 'allow' });
    await expect(second).resolves.toBeUndefined();
  });
});
