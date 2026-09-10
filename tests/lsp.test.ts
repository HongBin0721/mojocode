import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LspManager, type LspCheckResult } from '../src/lsp/manager.js';
import { lspConfigSchema } from '../src/config/schema.js';
import { loadRawConfig } from '../src/config/load.js';
import { createFileTools } from '../src/tools/files.js';
import { summarizeToolResult } from '../src/tools/index.js';
import { setLocale } from '../src/i18n/index.js';
import type { ToolContext } from '../src/tools/context.js';
import { hookTools } from '../src/agent/hooked-tools.js';
import { lspExtension } from '../src/extensions/lsp/index.js';
import { recordingExtensionApi } from './support/extension-api.js';

const FAKE_SERVER = fileURLToPath(new URL('./support/fake-lsp.mjs', import.meta.url));

/** 指向 fake server 的配置:用 node 自己当命令,不依赖 PATH 上装了什么。 */
function fakeConfig(overrides: Record<string, unknown> = {}) {
  return lspConfigSchema.parse({
    timeoutMs: 3000,
    servers: {
      fake: { command: process.execPath, args: [FAKE_SERVER], extensions: ['.zz'] },
    },
    ...overrides,
  });
}

describe('LspManager 端到端(fake server)', () => {
  let root: string;
  const managers: LspManager[] = [];

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-lsp-'));
  });
  afterAll(async () => {
    await Promise.all(managers.map((m) => m.dispose()));
    await fs.rm(root, { recursive: true, force: true });
  });

  function makeManager(config = fakeConfig()) {
    const manager = new LspManager(root, config);
    managers.push(manager);
    return manager;
  }

  it('回喂错误与警告,过滤 info/hint,didChange 路径也通', async () => {
    const manager = makeManager();
    const file = path.join(root, 'a.zz');

    // didOpen:一处 BUG + 一处 WARN(fake server 还会每行塞一条 hint)。
    const first = (await manager.check(file, 'hello BUG\nWARN here')) as LspCheckResult;
    expect(first).toBeDefined();
    expect(first.errors).toBe(1);
    expect(first.warnings).toBe(1);
    expect(first.items[0]).toBe('1:7 error: found BUG marker (fake E001)');
    expect(first.items[1]).toBe('2:1 warning: found WARN marker (fake)');

    // 同一文件第二次检查走 didChange;干净内容 → undefined(空诊断不打扰模型)。
    await expect(manager.check(file, 'all clean now')).resolves.toBeUndefined();

    // 再改坏:仍能拿到新版本的诊断。
    const third = (await manager.check(file, 'BUG again')) as LspCheckResult;
    expect(third.errors).toBe(1);
  }, 15_000);

  it('enabled: false 时完全不动', async () => {
    const manager = makeManager(fakeConfig({ enabled: false }));
    await expect(manager.check(path.join(root, 'b.zz'), 'BUG')).resolves.toBeUndefined();
  });

  it('没有服务器接管的扩展名 → undefined', async () => {
    const manager = makeManager();
    await expect(manager.check(path.join(root, 'c.unknown'), 'BUG')).resolves.toBeUndefined();
  });

  it('命令不存在时静默降级,不抛错', async () => {
    const manager = makeManager(
      lspConfigSchema.parse({
        servers: { ghost: { command: 'mojocode-definitely-missing-cmd', extensions: ['.zz'] } },
      }),
    );
    await expect(manager.check(path.join(root, 'd.zz'), 'BUG')).resolves.toBeUndefined();
    // 第二次也不该抛(已记为拉起失败,不再重试)。
    await expect(manager.check(path.join(root, 'd.zz'), 'BUG')).resolves.toBeUndefined();
  }, 15_000);

  // rust-analyzer(cargo check 流式)与 gopls(按包检查)会先发一个空批次,
  // 真正的错误稍后才到。在第一批就收工等于把"有错"报成"干净"。
  it('先空后实的服务器:等到真正的诊断,不把有错报成干净', async () => {
    const manager = makeManager();
    const result = (await manager.check(path.join(root, 'late.zz'), 'LATE BUG here')) as LspCheckResult;
    expect(result).toBeDefined();
    expect(result.errors).toBe(1);
    expect(result.items[0]).toContain('found BUG marker');
  }, 15_000);

  it('先空后实但确实干净:宽限期过后照常返回 undefined', async () => {
    const manager = makeManager();
    await expect(manager.check(path.join(root, 'late-clean.zz'), 'LATE and clean')).resolves.toBeUndefined();
  }, 15_000);

  // 服务器半路死掉:第一次拿不到诊断很正常,但此后每次都白等一个完整的
  // timeoutMs 就是每次 write/edit 都卡三秒。必须当场记死。
  it('握手后死掉的服务器被记死,后续检查立即返回而不是每次干等超时', async () => {
    const manager = makeManager(fakeConfig({ timeoutMs: 1000 }));
    const file = path.join(root, 'die.zz');
    await expect(manager.check(file, 'DIE now')).resolves.toBeUndefined();

    const started = Date.now();
    await expect(manager.check(file, 'BUG here')).resolves.toBeUndefined();
    await expect(manager.check(file, 'BUG here')).resolves.toBeUndefined();
    // 记死之后是纯内存查表;放宽到 500ms 也远低于一次 1000ms 的超时。
    expect(Date.now() - started).toBeLessThan(500);
  }, 15_000);

  it('扩展名大小写不影响 languageId(否则服务器不认这门语言)', async () => {
    const manager = makeManager(
      lspConfigSchema.parse({
        timeoutMs: 3000,
        servers: {
          fake: { command: process.execPath, args: [FAKE_SERVER], extensions: ['.zz'] },
        },
      }),
    );
    const result = (await manager.check(path.join(root, 'Upper.ZZ'), 'LANGID')) as LspCheckResult;
    expect(result?.items[0]).toContain('languageId=zz');
  }, 15_000);

  // 配置里的空字节让 spawn **同步**抛 ERR_INVALID_ARG_VALUE(不是 'error' 事件),
  // 漏出去就会把一次已经成功的写入变成工具报错。命令不存在走的是异步路径,
  // 上面那条测试盖不到这里。
  it('spawn 同步抛错(命令含空字节)也只是静默降级', async () => {
    const manager = makeManager(
      lspConfigSchema.parse({ servers: { bad: { command: 'bad\u0000cmd', extensions: ['.zz'] } } }),
    );
    await expect(manager.check(path.join(root, 'f.zz'), 'BUG')).resolves.toBeUndefined();
    await expect(manager.check(path.join(root, 'f.zz'), 'BUG')).resolves.toBeUndefined();
  });

  it('服务器死在写入途中不会抛出未捕获的 EPIPE', async () => {
    const manager = makeManager(fakeConfig({ timeoutMs: 1000 }));
    const file = path.join(root, 'epipe.zz');
    await manager.check(file, 'DIE now');
    // 对着已死的服务器再发一大段内容(超过 64KB 管道缓冲,写不可能是原子的)。
    await expect(manager.check(file, `BUG ${'x'.repeat(200_000)}`)).resolves.toBeUndefined();
  }, 15_000);

  it('graceMs 可按服务器覆盖:宽限调小后,迟到的批次确实等不到', async () => {
    const manager = makeManager(
      lspConfigSchema.parse({
        timeoutMs: 3000,
        servers: {
          fake: { command: process.execPath, args: [FAKE_SERVER], extensions: ['.zz'], graceMs: 10 },
        },
      }),
    );
    // LATE 的真诊断 80ms 后才来,10ms 宽限接不住 → 报"干净"。这正是可配的
    // 意义:反过来,大项目上 rust-analyzer 超过内置启发值时把它调大就能接住。
    await expect(manager.check(path.join(root, 'grace.zz'), 'LATE BUG')).resolves.toBeUndefined();
  }, 15_000);

  it('改 A 波及 B:B 的新诊断以 otherFiles 报出', async () => {
    const manager = makeManager();
    const fileB = path.join(root, 'xb.zz');
    await manager.check(fileB, 'clean here'); // B 先检查过(已打开)
    const res = (await manager.check(path.join(root, 'xa.zz'), 'CROSSFILE BUG')) as LspCheckResult;
    expect(res.errors).toBe(1);
    expect(res.otherFiles?.[0]).toContain('xb.zz');
    expect(res.otherFiles?.[0]).toContain('1 error');
  }, 15_000);

  it('本文件干净但改炸了 B:仍然出声,而不是沉默', async () => {
    const manager = makeManager();
    await manager.check(path.join(root, 'yb.zz'), 'clean');
    const res = (await manager.check(path.join(root, 'ya.zz'), 'CROSSFILE clean')) as LspCheckResult;
    expect(res).toBeDefined();
    expect(res.errors).toBe(0);
    expect(res.items).toEqual([]);
    expect(res.otherFiles).toHaveLength(1);
  }, 15_000);

  it('没检查过的文件收到推送不算波及(全工程分析器的存量噪音)', async () => {
    const manager = makeManager();
    // 只检查 A,不先检查 B:fake 只会给打开过的文件推送,这里 A 是唯一
    // 打开的文件,CROSSFILE 无人可炸 → 没有 otherFiles。
    const res = (await manager.check(path.join(root, 'za.zz'), 'CROSSFILE BUG')) as LspCheckResult;
    expect(res.errors).toBe(1);
    expect(res.otherFiles).toBeUndefined();
  }, 15_000);

  // 全工程分析器编辑任一文件后会把所有打开文件的诊断原样重发。B 早就有的、
  // 与这次改动无关的报错不该被算作被 A 波及。
  it('原样重发的旧诊断不算波及:B 的存量报错不归到 A 头上', async () => {
    const manager = makeManager();
    const fileB = path.join(root, 'rb.zz');
    await manager.check(fileB, 'BUG in B'); // B 自己就有一个错(存量)
    // 编辑 A(本身干净),服务器把 B 的**同一个**错原样重发。
    await expect(manager.check(path.join(root, 'ra.zz'), 'REPUBLISH clean')).resolves.toBeUndefined();
  }, 15_000);

  // 本文件自己的诊断超时了,但改动已经波及到 B——那份已经到手的观察不能丢。
  it('本文件超时也要报出已观察到的跨文件波及', async () => {
    const manager = makeManager(fakeConfig({ timeoutMs: 500 }));
    await manager.check(path.join(root, 'sb.zz'), 'clean'); // B 先打开
    // A 用 SILENT:自己永不回诊断(等到超时),但 CROSSFILE 已炸了 B。
    const res = (await manager.check(path.join(root, 'sa.zz'), 'CROSSFILE SILENT')) as LspCheckResult;
    expect(res).toBeDefined();
    expect(res.items).toEqual([]);
    expect(res.otherFiles?.[0]).toContain('sb.zz');
  }, 15_000);

  it('用户条目可以禁用内置服务器', async () => {
    const manager = makeManager(
      lspConfigSchema.parse({ servers: { typescript: { enabled: false } } }),
    );
    await expect(manager.check(path.join(root, 'e.ts'), 'const x: number = "s";')).resolves.toBeUndefined();
  });
});

/**
 * 诊断经 lsp 扩展的 `tool_result` 钩子并进 write/edit 的结果:工具本身不再
 * 认识 LSP。跑的是**真实的工具 + 真实的钩子注册表 + fake LSP 服务器**,
 * 只有 ExtensionAPI 是假的——这条链路(写盘 → 钩子读盘 → 诊断改写结果)
 * 正是搬家时最容易接错的地方。
 */
describe('write/edit 经扩展回喂诊断', () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-lsp-tools-'));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  type Execute = (input: Record<string, unknown>, options: unknown) => Promise<Record<string, unknown>>;
  const executeOf = (tool: unknown): Execute => (tool as { execute: Execute }).execute;

  /** 真工具 + 真 HookRegistry + lsp 扩展;工具经 hookTools 包装,与 loop 同款。 */
  function makeHost(config: Record<string, unknown> = {}) {
    const { api, hooks } = recordingExtensionApi({
      id: 'lsp',
      root,
      config: { lsp: fakeConfig(config) } as never,
    });
    lspExtension.setup(api);
    const ctx = {
      root,
      readFiles: new Set<string>(),
    } as unknown as ToolContext;
    const tools = hookTools(createFileTools(ctx) as never, hooks, { subagent: false });
    let calls = 0;
    const call = (name: 'write' | 'edit', input: Record<string, unknown>) =>
      executeOf(tools[name])(input, { toolCallId: `c${(calls += 1)}` });
    return { hooks, call };
  }

  it('write 结果携带诊断;edit 基于写盘后的新内容重查,修好后字段整个消失', async () => {
    const { call } = makeHost();
    const wrote = await call('write', { path: 'a.zz', content: 'line one BUG' });
    expect(wrote.diagnostics).toMatchObject({ errors: 1, warnings: 0 });
    expect((wrote.diagnostics as { items: string[] }).items[0]).toContain('BUG');
    // 工具自己的字段一个不少(钩子是改写,不是替换)。
    expect(wrote).toMatchObject({ path: 'a.zz', changed: true, created: true });

    const edited = await call('edit', {
      path: 'a.zz',
      oldString: 'BUG',
      newString: 'fixed',
      replaceAll: false,
    });
    expect(edited.replacements).toBe(1);
    // 干净时不加字段:结果的 JSON 要和没装 LSP 时一字不差。
    expect('diagnostics' in edited).toBe(false);
  });

  it('lsp.enabled: false 时结果与从前完全一致', async () => {
    const { call } = makeHost({ enabled: false });
    const wrote = await call('write', { path: 'plain.zz', content: 'line one BUG' });
    expect('diagnostics' in wrote).toBe(false);
  });

  it('内容没变的 write 提前返回,不白跑一次诊断', async () => {
    const { call } = makeHost();
    await call('write', { path: 'same.zz', content: 'line one BUG' });
    const again = await call('write', { path: 'same.zz', content: 'line one BUG' });
    expect(again.changed).toBe(false);
    expect('diagnostics' in again).toBe(false);
  });

  it('工具报错时不查诊断(没有落地的内容可查)', async () => {
    const { call } = makeHost();
    await expect(
      call('edit', { path: 'missing.zz', oldString: 'x', newString: 'y', replaceAll: false }),
    ).rejects.toThrow();
  });

  it('非 write/edit 的工具结果原样通过', async () => {
    const { api, hooks } = recordingExtensionApi({
      id: 'lsp',
      root,
      config: { lsp: fakeConfig() } as never,
    });
    lspExtension.setup(api);
    const output = await hooks.toolResult({
      callId: 'c1',
      toolName: 'read',
      input: {},
      output: { path: 'a.zz', content: 'x' },
      isError: false,
      subagent: false,
    });
    expect(output).toEqual({ path: 'a.zz', content: 'x' });
  });
});

describe('summarizeToolResult 的诊断后缀', () => {
  afterEach(() => setLocale('en'));

  it('有错误报错误数,只有警告报警告数,干净不加后缀', () => {
    setLocale('en');
    const base = { changed: true, created: false, lines: 3 };
    expect(
      summarizeToolResult('write', { ...base, diagnostics: { errors: 2, warnings: 1, items: [] } }),
    ).toBe('written, 3 lines · 2 LSP errors');
    expect(
      summarizeToolResult('write', { ...base, diagnostics: { errors: 0, warnings: 1, items: [] } }),
    ).toBe('written, 3 lines · 1 LSP warnings');
    expect(summarizeToolResult('write', base)).toBe('written, 3 lines');
    expect(
      summarizeToolResult('edit', { replacements: 1, diagnostics: { errors: 1, warnings: 0, items: [] } }),
    ).toBe('1 replacement · 1 LSP errors');
  });
});

describe('lsp 配置分层', () => {
  let home: string;
  let root: string;
  const oldHome = process.env.HOME;

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-lsp-home-'));
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-lsp-root-'));
    process.env.HOME = home;
  });
  afterAll(async () => {
    process.env.HOME = oldHome;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeConfig(dir: string, config: unknown) {
    await fs.mkdir(path.join(dir, '.mojocode'), { recursive: true });
    await fs.writeFile(path.join(dir, '.mojocode', 'config.json'), JSON.stringify(config));
  }

  it('默认开启;项目层只加一个服务器不抹掉全局层的条目与开关', async () => {
    const empty = await loadRawConfig({ root, env: {} });
    expect(empty.config.lsp.enabled).toBe(true);
    expect(empty.config.lsp.timeoutMs).toBe(3000);

    await writeConfig(home, {
      lsp: { enabled: false, servers: { pyright: { command: 'my-pyright' } } },
    });
    await writeConfig(root, { lsp: { servers: { gopls: { args: ['-remote=auto'] } } } });
    const { config } = await loadRawConfig({ root, env: {} });
    // 项目层没写 enabled,全局层的 false 不能被 .partial() 的默认值踩掉。
    expect(config.lsp.enabled).toBe(false);
    // servers 按 id 合并:两层的条目都在。
    expect(config.lsp.servers.pyright?.command).toBe('my-pyright');
    expect(config.lsp.servers.gopls?.args).toEqual(['-remote=auto']);
  });
});
