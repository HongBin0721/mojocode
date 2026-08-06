import { describe, expect, it, vi } from 'vitest';
import { PermissionDeniedError, PermissionGate } from '../src/permissions/gate.js';
import { EventBus, type PermissionDecision, type PermissionRequest } from '../src/core/events.js';
import { presetById, type Permissions } from '../src/config/schema.js';

function makeGate(
  permissions: Permissions,
  decision: PermissionDecision = { type: 'allow' },
  plan = false,
) {
  const asked: PermissionRequest[] = [];
  const ask = vi.fn(async (req: PermissionRequest) => {
    asked.push(req);
    return decision;
  });
  const gate = new PermissionGate({
    root: '/tmp/does-not-matter',
    permissions,
    plan,
    rules: { allowBash: [], denyBash: [], allowWrite: [], denyPath: [], allowNet: [] },
    ask,
    bus: new EventBus(),
  });
  return { gate, ask, asked };
}

const READ_ONLY_NEVER: Permissions = { sandbox: 'read-only', approval: 'never' };

describe('PermissionGate 两轴决策矩阵', () => {
  it('read-only+never:拒绝一切改动,且不询问(不可升级)', async () => {
    const { gate, ask } = makeGate(READ_ONLY_NEVER);
    expect(() => gate.assertCanMutate('src/a.ts')).toThrow(PermissionDeniedError);
    await expect(gate.checkWrite('src/a.ts')).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(gate.checkBash('npm install', '.')).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(ask).not.toHaveBeenCalled();
  });

  it('read-only 沙箱仍放行只读命令', async () => {
    const { gate, ask } = makeGate(READ_ONLY_NEVER);
    await expect(gate.checkBash('git status', '.')).resolves.toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  // Read Only 预设与旧 readonly 的本质区别:写入可以逐次升级确认。
  it('read-only+on-request:写入弹升级确认,批准即放行', async () => {
    const { gate, ask } = makeGate(presetById('read-only'));
    expect(() => gate.assertCanMutate('src/a.ts')).not.toThrow();
    await expect(gate.checkWrite('src/a.ts', 'diff')).resolves.toBeUndefined();
    expect(ask).toHaveBeenCalledOnce();
  });

  // 只读沙箱下"始终允许写 src/**"是自相矛盾的:升级确认不该产生可记住的规则。
  it('read-only 的升级确认不带 suggestedRule', async () => {
    const { gate, asked } = makeGate(presetById('read-only'));
    await gate.checkWrite('src/a.ts');
    await gate.checkBash('npm install lodash', '.');
    expect(asked[0]!.suggestedRule).toBeUndefined();
    expect(asked[1]!.suggestedRule).toBeUndefined();
  });

  it('ask 预设(workspace-write+untrusted):写入与命令都确认', async () => {
    const { gate, ask } = makeGate(presetById('ask'));
    await gate.checkWrite('src/a.ts', 'diff');
    expect(ask).toHaveBeenCalledOnce();
    await gate.checkBash('npm install lodash', '.');
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('auto 预设(workspace-write+on-request):工作区写入免确认,命令仍确认', async () => {
    const { gate, ask } = makeGate(presetById('auto'));
    await gate.checkWrite('src/a.ts');
    expect(ask).not.toHaveBeenCalled();
    await gate.checkBash('npm install lodash', '.');
    expect(ask).toHaveBeenCalledOnce();
  });

  // 没有 OS 沙箱能把命令圈在工作区里,never 下沙箱外的操作只能直接失败。
  it('workspace-write+never:写入自由,非白名单命令直接拒且不询问', async () => {
    const { gate, ask } = makeGate({ sandbox: 'workspace-write', approval: 'never' });
    await expect(gate.checkWrite('src/a.ts')).resolves.toBeUndefined();
    await expect(gate.checkBash('npm install lodash', '.')).rejects.toThrow(/cannot be escalated/);
    expect(ask).not.toHaveBeenCalled();
  });

  it('turns a denial into an error the model can read', async () => {
    const { gate } = makeGate(presetById('ask'), { type: 'deny' });
    await expect(gate.checkWrite('src/a.ts')).rejects.toThrow(/denied/i);
  });

  it('stops asking after allow-always for a matching path', async () => {
    const { gate, ask } = makeGate(presetById('ask'), { type: 'allow-always', rule: 'src/**' });
    await gate.checkWrite('src/a.ts');
    expect(ask).toHaveBeenCalledOnce();
    await gate.checkWrite('src/nested/b.ts');
    expect(ask).toHaveBeenCalledOnce(); // 被记住的规则覆盖
    await gate.checkWrite('other/c.ts');
    expect(ask).toHaveBeenCalledTimes(2); // 在规则之外,所以再次询问
  });

  it('remembers an allowed bash prefix for the session', async () => {
    const { gate, ask } = makeGate(presetById('ask'), {
      type: 'allow-always',
      rule: 'Bash(npm install:*)',
    });
    await gate.checkBash('npm install lodash', '.');
    expect(ask).toHaveBeenCalledOnce();
    await gate.checkBash('npm install react', '.');
    expect(ask).toHaveBeenCalledOnce();
  });

  it('refuses hard-denied commands even after the user allowed the prefix', async () => {
    const { gate } = makeGate(presetById('ask'), { type: 'allow-always', rule: 'Bash(git:*)' });
    await expect(gate.checkBash('git push --force', '.')).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('full-access(danger-full-access+never):一切放行,含硬拒名单', async () => {
    const { gate, ask } = makeGate(presetById('full-access'));
    await expect(gate.checkBash('rm -rf build', '.')).resolves.toBeUndefined();
    await expect(gate.checkWrite('src/a.ts')).resolves.toBeUndefined();
    await expect(gate.checkMcpTool('mcp__db__query', {})).resolves.toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  it('MCP 工具不透明:非 full-access 沙箱一律确认', async () => {
    const { gate, ask } = makeGate(presetById('auto'));
    await gate.checkMcpTool('mcp__db__query', { sql: 'select 1' });
    expect(ask).toHaveBeenCalledOnce();
  });

  it('MCP 在 never 策略下直接拒,不询问', async () => {
    const { gate, ask } = makeGate({ sandbox: 'workspace-write', approval: 'never' });
    await expect(gate.checkMcpTool('mcp__db__query', {})).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('plan 模式', () => {
  it('拒绝一切改动,且不询问', async () => {
    const { gate, ask } = makeGate(presetById('ask'), { type: 'allow' }, true);
    expect(() => gate.assertCanMutate('src/a.ts')).toThrow(PermissionDeniedError);
    await expect(gate.checkWrite('src/a.ts')).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(gate.checkBash('npm install', '.')).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(gate.checkMcpTool('mcp__db__query', {})).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(ask).not.toHaveBeenCalled();
  });

  // 拒绝理由是喂给模型的:指错方向的话它会去劝用户重启,而不是把方案写完。
  it('拒绝理由指向 exit_plan,而不是让用户重启', async () => {
    const { gate } = makeGate(presetById('ask'), { type: 'allow' }, true);
    expect(() => gate.assertCanMutate('src/a.ts')).toThrow(/exit_plan/);
    expect(() => gate.assertCanMutate('src/a.ts')).not.toThrow(/--readonly/);
  });

  it('仍放行只读命令', async () => {
    const { gate, ask } = makeGate(presetById('ask'), { type: 'allow' }, true);
    await expect(gate.checkBash('git status', '.')).resolves.toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  // 硬拒判定排在模式判定之前,plan 的话术不该盖掉它。
  it('灾难性命令仍走硬拒理由,不被 plan 文案盖掉', async () => {
    const { gate } = makeGate(presetById('ask'), { type: 'allow' }, true);
    await expect(gate.checkBash('rm -rf build', '.')).rejects.toThrow(/Run it yourself/);
  });

  it('requestPlanApproval 批准时返回结果而不抛错,并发 permission-resolved', async () => {
    const bus = new EventBus();
    const resolved: PermissionDecision[] = [];
    bus.on((e) => {
      if (e.type === 'permission-resolved') resolved.push(e.decision);
    });
    const gate = new PermissionGate({
      root: '/tmp/does-not-matter',
      permissions: presetById('ask'),
      plan: true,
      rules: { allowBash: [], denyBash: [], allowWrite: [], denyPath: [], allowNet: [] },
      ask: async () => ({ type: 'allow' }),
      bus,
    });
    await expect(gate.requestPlanApproval('# 方案')).resolves.toEqual({ approved: true });
    expect(resolved).toEqual([{ type: 'allow' }]);
  });

  // 方案被打回是正常往复,不是失败——抛错会在时间线上画成红色的工具报错。
  it('requestPlanApproval 被拒绝时返回 approved:false,不抛错', async () => {
    const { gate } = makeGate(presetById('ask'), { type: 'deny', reason: 'keep refining' }, true);
    await expect(gate.requestPlanApproval('# 方案')).resolves.toEqual({
      approved: false,
      reason: 'keep refining',
    });
  });

  // 方案不产生规则,allow-always 对它没有意义;真收到了也绝不当作批准。
  it('收到 allow-always 之类的决定按未批准处理,不静默放行', async () => {
    const { gate } = makeGate(presetById('ask'), { type: 'allow-always', rule: 'src/**' }, true);
    await expect(gate.requestPlanApproval('# 方案')).resolves.toMatchObject({ approved: false });
  });

  it('方案审批带 kind:plan,正文即方案本身', async () => {
    const asked: PermissionRequest[] = [];
    const gate = new PermissionGate({
      root: '/tmp/does-not-matter',
      permissions: presetById('ask'),
      plan: true,
      rules: { allowBash: [], denyBash: [], allowWrite: [], denyPath: [], allowNet: [] },
      ask: async (req) => {
        asked.push(req);
        return { type: 'allow' };
      },
      bus: new EventBus(),
    });

    await gate.requestPlanApproval('# 方案\n\n1. 改 a.ts');

    expect(asked[0]).toMatchObject({
      kind: 'plan',
      toolName: 'exit_plan',
      detail: '# 方案\n\n1. 改 a.ts',
    });
  });
});

describe('会话规则导出/导入(跨恢复还原)', () => {
  it('export/import 往返后规则依旧生效,且导入去重', async () => {
    const { gate, ask } = makeGate(presetById('ask'), { type: 'allow-always', rule: 'Bash(npm install:*)' });
    await gate.checkBash('npm install lodash', '.');
    expect(ask).toHaveBeenCalledOnce();

    const exported = gate.exportSessionRules();
    expect(exported.allowBash).toEqual(['Bash(npm install:*)']);
    // 返回副本:改动导出结果不应影响 gate 内部状态。
    exported.allowBash.push('Bash(rm:*)');
    expect(gate.exportSessionRules().allowBash).toEqual(['Bash(npm install:*)']);

    // 恢复到一个新 gate:导入后同类命令不再询问。
    const restored = makeGate(presetById('ask'));
    restored.gate.setSessionRules({ allowBash: ['Bash(npm install:*)'], allowWrite: ['src/**'] });
    restored.gate.setSessionRules({ allowBash: ['Bash(npm install:*)'], allowWrite: ['src/**'] }); // 去重
    await restored.gate.checkBash('npm install react', '.');
    await restored.gate.checkWrite('src/a.ts');
    expect(restored.ask).not.toHaveBeenCalled();
    expect(restored.gate.exportSessionRules()).toEqual({
      allowBash: ['Bash(npm install:*)'],
      allowWrite: ['src/**'],
      allowNet: [],
    });
  });

  it('setSessionRules 是替换而非追加:切会话不会把上一段的授权带过去', async () => {
    const { gate, ask } = makeGate(presetById('ask'), { type: 'allow-always', rule: 'Bash(npm install:*)' });
    await gate.checkBash('npm install lodash', '.');
    expect(gate.exportSessionRules().allowBash).toEqual(['Bash(npm install:*)']);

    // /resume 切到另一个会话:它自己的规则完全取代前一段的。
    gate.setSessionRules({ allowBash: ['Bash(git:*)'], allowWrite: [] });
    expect(gate.exportSessionRules()).toEqual({
      allowBash: ['Bash(git:*)'],
      allowWrite: [],
      allowNet: [],
    });

    // 上一段批准过的命令必须重新询问,否则授权跨会话泄漏。
    ask.mockClear();
    await gate.checkBash('npm install react', '.');
    expect(ask).toHaveBeenCalledOnce();
  });

  it('remember 触发 onRulesChanged,导入不触发', async () => {
    const onRulesChanged = vi.fn();
    const gate = new PermissionGate({
      root: '/tmp/does-not-matter',
      permissions: presetById('ask'),
      plan: false,
      rules: { allowBash: [], denyBash: [], allowWrite: [], denyPath: [], allowNet: [] },
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
      permissions: presetById('ask'),
      plan: false,
      rules: { allowBash: [], denyBash: [], allowWrite: [], denyPath: [], allowNet: [] },
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

/**
 * 端到端锁死:执行项目代码的命令在只读语境下不再免检。
 * 这是 read-only / plan 承诺的一部分——package.json 的脚本可以写文件,
 * "只读"不能取决于仓库自觉。
 */
describe('只读语境下的项目代码命令', () => {
  it('read-only+on-request:npm test 弹升级确认,不再免检放行', async () => {
    const { gate, ask } = makeGate(presetById('read-only'));
    await expect(gate.checkBash('npm test', '.')).resolves.toBeUndefined();
    expect(ask).toHaveBeenCalledOnce();
  });

  it('read-only+never:npm test 直接拒,不询问', async () => {
    const { gate, ask } = makeGate(READ_ONLY_NEVER);
    await expect(gate.checkBash('npm test', '.')).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(ask).not.toHaveBeenCalled();
  });

  it('计划模式:npm test 被拒且理由指向 exit_plan', async () => {
    const { gate } = makeGate(presetById('ask'), { type: 'allow' }, true);
    await expect(gate.checkBash('npm test', '.')).rejects.toThrow(/exit_plan/);
  });

  it('可写沙箱不受影响:auto 预设下 npm test 仍免确认', async () => {
    const { gate, ask } = makeGate(presetById('auto'));
    await expect(gate.checkBash('npm test', '.')).resolves.toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  // 持久化的 allow 规则是可写语境下授的权,read-only 沙箱下不自动生效。
  it('read-only 下项目配置的 allow 规则不免检', async () => {
    const asked: PermissionRequest[] = [];
    const gate = new PermissionGate({
      root: '/tmp/does-not-matter',
      permissions: presetById('read-only'),
      plan: false,
      rules: { allowBash: ['Bash(npm install:*)'], denyBash: [], allowWrite: [], denyPath: [], allowNet: [] },
      ask: async (req) => {
        asked.push(req);
        return { type: 'allow' };
      },
      bus: new EventBus(),
    });
    await gate.checkBash('npm install lodash', '.');
    expect(asked).toHaveLength(1);
  });
});

describe('联网权限(checkNet)', () => {
  function makeNetGate(
    permissions: Permissions,
    opts: { decision?: PermissionDecision; plan?: boolean; allowNet?: string[] } = {},
  ) {
    const asked: PermissionRequest[] = [];
    const ask = vi.fn(async (req: PermissionRequest) => {
      asked.push(req);
      return opts.decision ?? ({ type: 'allow' } as PermissionDecision);
    });
    const gate = new PermissionGate({
      root: '/tmp/does-not-matter',
      permissions,
      plan: opts.plan ?? false,
      rules: {
        allowBash: [],
        denyBash: [],
        allowWrite: [],
        denyPath: [],
        allowNet: opts.allowNet ?? [],
      },
      ask,
      bus: new EventBus(),
    });
    return { gate, ask, asked };
  }

  it('私网/云元数据硬拒,danger-full-access 也不豁免', async () => {
    const { gate, ask } = makeNetGate(presetById('full-access'));
    await expect(
      gate.checkNet({ tool: 'web_fetch', url: 'http://169.254.169.254/latest/meta-data/' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      gate.checkNet({ tool: 'web_fetch', url: 'http://192.168.1.1/' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(ask).not.toHaveBeenCalled();
  });

  it('公网形状但解析到内网的域名被硬拒(DNS 层,danger-full-access 不豁免)', async () => {
    // 真实 DNS:nip.io 把 IP 编进域名,localtest.me 常年指向 127.0.0.1。
    // 这类名字过得了字面量判断,是绕过私网硬拒最省事的办法。
    const { gate, ask } = makeNetGate(presetById('full-access'));
    await expect(
      gate.checkNet({ tool: 'web_fetch', url: 'http://127.0.0.1.nip.io:8080/' }),
    ).rejects.toThrow(/resolves to .*internal address/);
    expect(ask).not.toHaveBeenCalled();
  });

  it('非 http(s) URL 直接拒绝', async () => {
    const { gate, ask } = makeNetGate(presetById('ask'));
    await expect(
      gate.checkNet({ tool: 'web_fetch', url: 'file:///etc/passwd' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(ask).not.toHaveBeenCalled();
  });

  it('danger-full-access 放行公网目标,不询问', async () => {
    const { gate, ask } = makeNetGate(presetById('full-access'));
    await expect(gate.checkNet({ tool: 'web_fetch', url: 'https://example.com/' })).resolves.toBeUndefined();
    await expect(gate.checkNet({ tool: 'web_search', query: 'anything' })).resolves.toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  it('ask 预设下弹确认,带 network risk 与建议规则', async () => {
    const { gate, asked } = makeNetGate(presetById('ask'));
    await gate.checkNet({ tool: 'web_fetch', url: 'https://docs.foo.dev/guide' });
    await gate.checkNet({ tool: 'web_search', query: 'zod v4 changes' });
    expect(asked).toHaveLength(2);
    expect(asked[0]!.risk).toBe('network');
    expect(asked[0]!.suggestedRule).toBe('WebFetch(domain:docs.foo.dev)');
    expect(asked[0]!.detail).toBe('https://docs.foo.dev/guide');
    expect(asked[1]!.suggestedRule).toBe('WebSearch');
  });

  it('配置里的 allowNet 规则放行,不询问(域名与 WebSearch 各自独立)', async () => {
    const { gate, ask } = makeNetGate(presetById('ask'), {
      allowNet: ['WebFetch(domain:docs.foo.dev)', 'WebSearch'],
    });
    await expect(
      gate.checkNet({ tool: 'web_fetch', url: 'https://docs.foo.dev/a/b' }),
    ).resolves.toBeUndefined();
    await expect(gate.checkNet({ tool: 'web_search', query: 'q' })).resolves.toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  });

  it('approval=never:无规则拒绝且指引 allowNet;有规则照常放行', async () => {
    const denied = makeNetGate({ sandbox: 'workspace-write', approval: 'never' });
    await expect(
      denied.gate.checkNet({ tool: 'web_search', query: 'q' }),
    ).rejects.toThrow(/allowNet/);
    expect(denied.ask).not.toHaveBeenCalled();

    const allowed = makeNetGate(
      { sandbox: 'workspace-write', approval: 'never' },
      { allowNet: ['WebSearch'] },
    );
    await expect(allowed.gate.checkNet({ tool: 'web_search', query: 'q' })).resolves.toBeUndefined();
  });

  it('plan 模式允许联网:走确认而非硬拒;full-access 语义在 plan 下不豁免确认', async () => {
    const { gate, asked } = makeNetGate(presetById('ask'), { plan: true });
    await expect(
      gate.checkNet({ tool: 'web_fetch', url: 'https://example.com/' }),
    ).resolves.toBeUndefined();
    expect(asked).toHaveLength(1);
  });

  it('allow-always 记进 allowNet 桶:同域第二次不再询问,导出可见', async () => {
    const { gate, ask } = makeNetGate(presetById('ask'), {
      decision: { type: 'allow-always', rule: 'WebFetch(domain:docs.foo.dev)' },
    });
    await gate.checkNet({ tool: 'web_fetch', url: 'https://docs.foo.dev/1' });
    await gate.checkNet({ tool: 'web_fetch', url: 'https://docs.foo.dev/2' });
    expect(ask).toHaveBeenCalledOnce();
    expect(gate.exportSessionRules().allowNet).toEqual(['WebFetch(domain:docs.foo.dev)']);
    // bash/write 桶不受污染
    expect(gate.exportSessionRules().allowBash).toEqual([]);
  });

  it('read-only 沙箱下 suggestedRule 不被抑制(域名信任与沙箱档位无关)', async () => {
    const { gate, asked } = makeNetGate(presetById('read-only'));
    await gate.checkNet({ tool: 'web_fetch', url: 'https://example.com/' });
    expect(asked[0]!.suggestedRule).toBe('WebFetch(domain:example.com)');
  });

  it('会话规则跨恢复还原:setSessionRules 带 allowNet,旧格式(无 allowNet)也兼容', async () => {
    const { gate, ask } = makeNetGate(presetById('ask'));
    gate.setSessionRules({ allowBash: [], allowWrite: [], allowNet: ['WebSearch'] });
    await expect(gate.checkNet({ tool: 'web_search', query: 'q' })).resolves.toBeUndefined();
    expect(ask).not.toHaveBeenCalled();

    // 旧会话文件没有 allowNet 字段:导入后清空,不残留上一段的授权。
    gate.setSessionRules({ allowBash: [], allowWrite: [] });
    expect(gate.exportSessionRules().allowNet).toEqual([]);
  });
});

// 子 agent 没有 exit_plan(方案审批是主 agent 与用户之间的事)也问不了用户:
// 照抄主 agent 的拒绝理由会把它引向一个不存在的工具,拿到 NoSuchTool 再重试,
// 一路空转到步数上限。判定本身对主、子 agent 完全一致,只有措辞不同。
describe('硬停理由按调用方身份措辞', () => {
  it('计划模式:主 agent 被指向 exit_plan,子 agent 被明确告知没有它', async () => {
    const { gate } = makeGate(presetById('ask'), { type: 'allow' }, true);
    expect(() => gate.assertCanMutate('src/a.ts')).toThrow(/call the exit_plan tool/);

    let subMessage = '';
    try {
      gate.assertCanMutate('src/a.ts', { subagent: true });
    } catch (err) {
      subMessage = (err as Error).message;
    }
    expect(subMessage).toMatch(/Do not call exit_plan/);
    expect(subMessage).not.toMatch(/call the exit_plan tool to submit/);
  });

  it('read-only+never:主 agent 被告知去找用户,子 agent 被告知它问不了', async () => {
    const { gate } = makeGate(READ_ONLY_NEVER);
    expect(() => gate.assertCanMutate('src/a.ts')).toThrow(/Ask the user to relaunch/);
    await expect(gate.checkBash('npm install', '.', { subagent: true })).rejects.toThrow(
      /You cannot ask the user/,
    );
  });

  it('身份只改措辞,不改判定:两者照样被拒', () => {
    const { gate } = makeGate(READ_ONLY_NEVER);
    expect(() => gate.assertCanMutate('src/a.ts', { subagent: true })).toThrow(
      PermissionDeniedError,
    );
    expect(() => gate.assertCanMutate('src/a.ts', { subagent: false })).toThrow(
      PermissionDeniedError,
    );
  });
});
