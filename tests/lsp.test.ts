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

  it('用户条目可以禁用内置服务器', async () => {
    const manager = makeManager(
      lspConfigSchema.parse({ servers: { typescript: { enabled: false } } }),
    );
    await expect(manager.check(path.join(root, 'e.ts'), 'const x: number = "s";')).resolves.toBeUndefined();
  });
});

describe('write/edit 工具回喂诊断', () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-lsp-tools-'));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  type Execute = (input: Record<string, unknown>, options: unknown) => Promise<Record<string, unknown>>;
  const executeOf = (tool: unknown): Execute => (tool as { execute: Execute }).execute;

  function makeCtx(check: (p: string, c: string) => Promise<LspCheckResult | undefined>) {
    return {
      root,
      gate: { assertCanMutate: () => {}, checkWrite: async () => {} },
      rules: { denyPath: [] },
      readFiles: new Set<string>(),
      lsp: { check },
    } as unknown as ToolContext;
  }

  it('write 结果携带诊断;edit 基于新内容检查', async () => {
    const seen: string[] = [];
    const ctx = makeCtx(async (_p, content) => {
      seen.push(content);
      return content.includes('BUG')
        ? { errors: 1, warnings: 0, items: ['1:1 error: boom'] }
        : undefined;
    });
    const { write, edit } = createFileTools(ctx);

    const wrote = await executeOf(write)({ path: 'a.ts', content: 'ok BUG' }, {});
    expect(wrote.diagnostics).toEqual({ errors: 1, warnings: 0, items: ['1:1 error: boom'] });

    // 修好之后:diagnostics 字段整个不出现,且 check 拿到的是 edit 后的内容。
    const edited = await executeOf(edit)(
      { path: 'a.ts', oldString: 'BUG', newString: 'fixed', replaceAll: false },
      {},
    );
    expect(edited.diagnostics).toBeUndefined();
    expect(seen).toEqual(['ok BUG', 'ok fixed']);
  });

  it('没有 lsp(禁用)时结果与从前完全一致', async () => {
    const ctx = {
      root,
      gate: { assertCanMutate: () => {}, checkWrite: async () => {} },
      rules: { denyPath: [] },
      readFiles: new Set<string>(),
    } as unknown as ToolContext;
    const { write } = createFileTools(ctx);
    const wrote = await executeOf(write)({ path: 'plain.ts', content: 'x' }, {});
    expect('diagnostics' in wrote).toBe(false);
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
