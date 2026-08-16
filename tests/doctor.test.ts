import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectDoctor,
  compareVersions,
  formatDoctor,
  type DoctorInput,
  type DoctorReport,
} from '../src/app/doctor.js';
import { configSchema } from '../src/config/schema.js';
import { nodeMinMajor } from '../src/config/version.js';
import { setLocale } from '../src/i18n/index.js';

let dir: string;

beforeEach(async () => {
  setLocale('en'); // 断言看的是 id/level,但 detail 里的固定文案按英文目录判断
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-doctor-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    root: dir,
    config: configSchema.parse({ provider: 'deepseek' }),
    sources: [],
    warnings: [],
    env: { DEEPSEEK_API_KEY: 'sk-secret-key-1234' },
    offline: true,
    sessionsDir: path.join(dir, 'sessions'),
    globalConfigFile: path.join(dir, 'global-config.json'),
    projectConfigFile: path.join(dir, 'project-config.json'),
    version: '1.0.0',
    ...overrides,
  };
}

function find(report: DoctorReport, id: string) {
  return report.sections.flatMap((s) => s.checks).find((c) => c.id === id);
}

/** 按 URL 分派的假 fetch:registry 与 provider 端点各走各的。 */
function fakeFetch(routes: Record<string, { status: number; body?: unknown }>): typeof fetch {
  return (async (url: string | URL) => {
    const href = typeof url === 'string' ? url : url.toString();
    const route = Object.entries(routes).find(([prefix]) => href.startsWith(prefix))?.[1];
    if (!route) throw new Error(`no route for ${href}`);
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      statusText: String(route.status),
      json: async () => route.body,
      text: async () => JSON.stringify(route.body ?? ''),
    } as Response;
  }) as unknown as typeof fetch;
}

describe('collectDoctor', () => {
  it('一切正常时全绿,offline 下不做任何联网检查', async () => {
    const report = await collectDoctor(input());
    expect(report.healthy).toBe(true);
    expect(report.counts.fail).toBe(0);
    expect(find(report, 'apiKey')?.level).toBe('ok');
    expect(find(report, 'model')?.detail).toContain('deepseek');
    expect(find(report, 'endpoint')?.level).toBe('info');
    expect(find(report, 'endpoint')?.detail).toContain('--offline');
    expect(find(report, 'version')?.detail).toBe('1.0.0'); // 未比对 → 不带任何后缀
  });

  it('密钥打码,完整值不出现在报告里', async () => {
    const report = await collectDoctor(input());
    const rendered = formatDoctor(report);
    expect(rendered).not.toContain('sk-secret-key-1234');
    expect(find(report, 'apiKey')?.detail).toContain('DEEPSEEK_API_KEY');
    expect(find(report, 'apiKey')?.detail).toContain('…');
  });

  it('缺少密钥是异常项,并给出修复指引', async () => {
    const report = await collectDoctor(input({ env: {} }));
    const key = find(report, 'apiKey');
    expect(key?.level).toBe('fail');
    expect(key?.hint).toContain('DEEPSEEK_API_KEY');
    expect(report.healthy).toBe(false);
  });

  it('未知服务商:baseURL 无从得知,报为异常', async () => {
    const report = await collectDoctor(
      input({ config: configSchema.parse({ provider: 'nope' }), env: {} }),
    );
    expect(find(report, 'provider')?.level).toBe('fail');
  });

  it('配置解析失败时照常出报告,并跳过依赖配置的分节', async () => {
    const report = await collectDoctor(
      input({ config: undefined, configError: 'config.json is not valid JSON' }),
    );
    expect(find(report, 'configLoad')?.level).toBe('fail');
    expect(report.sections.map((s) => s.id)).not.toContain('provider');
    // 与配置无关的检查仍要跑完,否则一处坏了就什么都看不见。
    expect(report.sections.map((s) => s.id)).toContain('workspace');
    expect(report.healthy).toBe(false);
  });

  it('加载期提示逐条呈现为提醒', async () => {
    const report = await collectDoctor(input({ warnings: ['permissionMode is the old setting'] }));
    expect(find(report, 'configWarning0')?.level).toBe('warn');
    expect(report.counts.warn).toBeGreaterThan(0);
  });

  it('danger-full-access 提醒,而不是当作正常档位', async () => {
    const report = await collectDoctor(
      input({ config: configSchema.parse({ provider: 'deepseek', sandbox: 'danger-full-access' }) }),
    );
    expect(find(report, 'mode')?.level).toBe('warn');
  });

  // 全新安装:~/.mojocode 连同 sessions/ 都还没建出来。这时报"不可写"会让
  // 第一次跑 doctor 的人直接吃一条异常加退出码 1,而其实一切正常。
  it('会话目录连同上级都还没建时,判定为"首次运行时创建"而不是不可写', async () => {
    const report = await collectDoctor(
      input({ sessionsDir: path.join(dir, 'never', 'created', 'sessions') }),
    );
    const check = find(report, 'sessionsDir');
    expect(check?.level).toBe('ok');
    expect(check?.detail).toContain('will be created');
    expect(report.healthy).toBe(true);
  });

  it('根目录不存在与不可写是两回事,提示各说各的', async () => {
    const missing = await collectDoctor(input({ root: path.join(dir, 'typo') }));
    expect(find(missing, 'cwd')?.level).toBe('fail');
    expect(find(missing, 'cwd')?.hint).toContain('does not exist');
  });

  it('自定义 apiKeyEnv 未设值时,仍认预设的环境变量(与 resolveProvider 一致)', async () => {
    const report = await collectDoctor(
      input({
        config: configSchema.parse({
          provider: 'deepseek',
          providers: { deepseek: { apiKeyEnv: 'MY_KEY' } },
        }),
      }),
    );
    const key = find(report, 'apiKey');
    expect(key?.level).toBe('ok');
    // 来源必须写清楚是哪一个变量给的,不能只剩一串打码。
    expect(key?.detail).toContain('DEEPSEEK_API_KEY');
  });

  it('自定义 apiKeyEnv 且全都没设时,提示要列全所有管用的变量名', async () => {
    const report = await collectDoctor(
      input({
        env: {},
        config: configSchema.parse({
          provider: 'deepseek',
          providers: { deepseek: { apiKeyEnv: 'MY_KEY' } },
        }),
      }),
    );
    const hint = find(report, 'apiKey')?.hint ?? '';
    expect(hint).toContain('MY_KEY');
    expect(hint).toContain('DEEPSEEK_API_KEY');
  });

  it('自定义端点无 key(Ollama/vLLM)不算缺陷,整体仍健康', async () => {
    // resolveProvider 允许无凭据的自定义 provider;apiKey 行曾无条件判 fail,
    // healthy=false 会让 CI 门禁对一份完全能用的配置退出 1。
    const report = await collectDoctor(
      input({
        env: {},
        config: configSchema.parse({
          provider: 'ollama',
          providers: { ollama: { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' } },
        }),
      }),
    );
    expect(find(report, 'provider')?.level).toBe('ok');
    const key = find(report, 'apiKey');
    expect(key?.level).toBe('ok');
    expect(key?.detail).toContain('not required');
    expect(key?.hint).toBeUndefined();
    expect(report.healthy).toBe(true);
  });

  it('解析失败(缺 key)时,窗口展示仍走 per-model 表,不退到默认值', async () => {
    const report = await collectDoctor(
      input({
        env: {},
        config: configSchema.parse({ provider: 'deepseek', model: 'deepseek-v4-flash' }),
      }),
    );
    expect(find(report, 'apiKey')?.level).toBe('fail');
    expect(find(report, 'model')?.detail).toContain('1000000');
  });

  it('GLM 老配置的小写 model id 归一后才查 per-model 窗口', async () => {
    const report = await collectDoctor(
      input({
        env: {},
        config: configSchema.parse({ provider: 'glm', model: 'glm-5.3' }),
      }),
    );
    expect(find(report, 'model')?.detail).toContain('GLM-5.3');
    expect(find(report, 'model')?.detail).toContain('1000000');
  });

  it('统计会话数量与占用', async () => {
    const sessions = path.join(dir, 'sessions');
    await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(path.join(sessions, 'a.jsonl'), 'x'.repeat(100));
    await fs.writeFile(path.join(sessions, 'a.meta.json'), '{}');
    await fs.writeFile(path.join(sessions, 'b.jsonl'), 'y'.repeat(50));
    const report = await collectDoctor(input());
    expect(find(report, 'sessionsDir')?.level).toBe('ok');
    expect(find(report, 'sessionsUsage')?.detail).toContain('2 sessions');
  });

  it('工作区检查报告 git 与项目指令文件', async () => {
    await fs.mkdir(path.join(dir, '.git'));
    await fs.writeFile(path.join(dir, 'AGENTS.md'), '# hi');
    const report = await collectDoctor(input());
    expect(find(report, 'git')?.detail).toBe('repository');
    expect(find(report, 'memory')?.detail).toBe('AGENTS.md');
  });
});

describe('联网检查', () => {
  const registry = 'https://registry.npmjs.org/';
  const endpoint = 'https://api.deepseek.com/models';

  it('端点可达且模型在列表里 → 全绿', async () => {
    const report = await collectDoctor(
      input({
        offline: false,
        fetchImpl: fakeFetch({
          [registry]: { status: 200, body: { version: '1.0.0' } },
          [endpoint]: { status: 200, body: { data: [{ id: 'deepseek-v4-flash' }] } },
        }),
      }),
    );
    expect(find(report, 'endpoint')?.level).toBe('ok');
    expect(find(report, 'modelListed')).toBeUndefined();
    expect(find(report, 'version')?.level).toBe('ok');
  });

  it('端点不认当前模型 → 提醒去查 mojocode models', async () => {
    const report = await collectDoctor(
      input({
        offline: false,
        fetchImpl: fakeFetch({
          [registry]: { status: 200, body: { version: '1.0.0' } },
          [endpoint]: { status: 200, body: { data: [{ id: 'deepseek-v9' }] } },
        }),
      }),
    );
    expect(find(report, 'modelListed')?.level).toBe('warn');
    expect(find(report, 'modelListed')?.hint).toContain('mojocode models');
  });

  it('401 是密钥问题 → 异常', async () => {
    const report = await collectDoctor(
      input({
        offline: false,
        fetchImpl: fakeFetch({
          [registry]: { status: 200, body: { version: '1.0.0' } },
          [endpoint]: { status: 401, body: { error: 'bad key' } },
        }),
      }),
    );
    expect(find(report, 'endpoint')?.level).toBe('fail');
    expect(report.healthy).toBe(false);
  });

  it('404 只说明端点不提供列表 → 提醒而非异常', async () => {
    const report = await collectDoctor(
      input({
        offline: false,
        fetchImpl: fakeFetch({
          [registry]: { status: 200, body: { version: '1.0.0' } },
          [endpoint]: { status: 404, body: {} },
        }),
      }),
    );
    expect(find(report, 'endpoint')?.level).toBe('warn');
    expect(report.healthy).toBe(true);
  });

  // undici 的顶层消息永远是 'fetch failed',真正的原因只在 cause 里——
  // 而这正是别人跑 doctor 想看的那一句。
  it('连不上时把 cause 链一并报出,而不是只有一句 fetch failed', async () => {
    const failing = (async (url: string | URL) => {
      const href = typeof url === 'string' ? url : url.toString();
      if (href.startsWith(registry)) {
        return { ok: true, status: 200, json: async () => ({ version: '1.0.0' }) } as Response;
      }
      const err = new Error('fetch failed');
      (err as { cause?: unknown }).cause = Object.assign(
        new Error('getaddrinfo ENOTFOUND api.deepseek.com'),
        { code: 'ENOTFOUND' },
      );
      throw err;
    }) as unknown as typeof fetch;

    const report = await collectDoctor(input({ offline: false, fetchImpl: failing }));
    const endpointCheck = find(report, 'endpoint');
    expect(endpointCheck?.level).toBe('fail');
    expect(endpointCheck?.detail).toContain('ENOTFOUND');
    expect(endpointCheck?.detail).toContain('api.deepseek.com');
  });

  it('registry 有新版本 → 提醒升级;registry 挂了不影响结论', async () => {
    const newer = await collectDoctor(
      input({
        offline: false,
        fetchImpl: fakeFetch({
          [registry]: { status: 200, body: { version: '2.0.0' } },
          [endpoint]: { status: 200, body: { data: [{ id: 'deepseek-v4-flash' }] } },
        }),
      }),
    );
    expect(find(newer, 'version')?.level).toBe('warn');
    expect(find(newer, 'version')?.detail).toContain('2.0.0');

    const down = await collectDoctor(
      input({
        offline: false,
        fetchImpl: fakeFetch({
          [registry]: { status: 500 },
          [endpoint]: { status: 200, body: { data: [{ id: 'deepseek-v4-flash' }] } },
        }),
      }),
    );
    expect(find(down, 'version')?.level).toBe('ok');
    expect(down.healthy).toBe(true);
  });
});

describe('compareVersions', () => {
  it('按数字段比较,不做字符串比较', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.1.0')).toBe(-1);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('预发布版小于同号正式版', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1);
  });

  it('预发布标识符逐段比:数字按数值、恒小于字母段,字母段按字典序', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0-beta.2')).toBe(-1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1); // 数值比,不是字典序
    expect(compareVersions('1.0.0-2', '1.0.0-rc')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.3', '1.0.0-beta.1')).toBe(-1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0-beta.1')).toBe(0);
  });

  it('前缀相同的预发布:标识符更多的一方更大', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBe(-1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0-beta')).toBe(1);
  });
});

describe('nodeMinMajor', () => {
  it('Node 下限取自 package.json 的 engines.node,不再写死', async () => {
    const pkg = JSON.parse(
      await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { engines?: { node?: string } };
    const expected = Number(pkg.engines?.node?.match(/>=\s*v?(\d+)/)?.[1]);
    expect(Number.isFinite(expected)).toBe(true);
    expect(nodeMinMajor()).toBe(expected);
  });
});

describe('formatDoctor', () => {
  it('每项一行,带状态符号与汇总', async () => {
    const report = await collectDoctor(input({ env: {} }));
    const text = formatDoctor(report);
    expect(text).toContain('✓');
    expect(text).toContain('✗');
    expect(text).toMatch(/\d+ ok · \d+ warnings · \d+ problems/);
    expect(text).not.toContain('\u001b['); // 未开颜色时不留任何转义
  });

  it('开启颜色时才写入 ANSI 序列', async () => {
    const text = formatDoctor(await collectDoctor(input()), { color: true });
    expect(text).toContain('\u001b[32m');
  });

  it('多行 detail 的续行与首行同列', async () => {
    const report = await collectDoctor(
      input({ config: undefined, configError: 'line one\nline two' }),
    );
    const lines = formatDoctor(report).split('\n');
    const first = lines.find((l) => l.includes('line one'))!;
    const second = lines.find((l) => l.includes('line two'))!;
    expect(second).toMatch(/^\s+line two$/);
    expect(second.indexOf('line two')).toBe(first.indexOf('line one'));
  });

  it('hint 行也落在同一列', async () => {
    const report = await collectDoctor(input({ env: {} }));
    const lines = formatDoctor(report).split('\n');
    const keyLine = lines.findIndex((l) => l.includes('not configured'));
    const hintLine = lines[keyLine + 1]!;
    expect(hintLine).toContain('→');
    expect(hintLine.indexOf('→')).toBe(lines[keyLine]!.indexOf('not configured'));
  });
});

describe('联网搜索分节', () => {
  const registry = 'https://registry.npmjs.org/';
  const glmSearch = 'https://open.bigmodel.cn/api/paas/v4/web_search';

  it('无任何搜索 key:info 陈述,不计入告警', async () => {
    const report = await collectDoctor(input());
    const backend = find(report, 'searchBackend');
    expect(backend?.level).toBe('info');
    expect(report.sections.some((s) => s.id === 'search')).toBe(true);
  });

  it('auto 解析出 glm:offline 下端点探测标记跳过', async () => {
    const report = await collectDoctor(
      input({ env: { DEEPSEEK_API_KEY: 'sk-x', ZHIPU_API_KEY: 'glm-key-123456' } }),
    );
    expect(find(report, 'searchBackend')?.level).toBe('ok');
    expect(find(report, 'searchBackend')?.detail).toContain('glm');
    expect(find(report, 'searchKey')?.detail).toContain('ZHIPU_API_KEY');
    expect(find(report, 'searchEndpoint')?.level).toBe('info');
  });

  it('显式后端缺 key:warn 并提示环境变量', async () => {
    const report = await collectDoctor(
      input({
        config: configSchema.parse({ provider: 'deepseek', search: { backend: 'exa' } }),
      }),
    );
    const backend = find(report, 'searchBackend');
    expect(backend?.level).toBe('warn');
    expect(backend?.hint).toContain('EXA_API_KEY');
  });

  it('端点探测:200 → ok,401 → fail 且提示 key', async () => {
    const ok = await collectDoctor(
      input({
        offline: false,
        env: { DEEPSEEK_API_KEY: 'sk-x', ZHIPU_API_KEY: 'glm-key-123456' },
        fetchImpl: fakeFetch({
          [registry]: { status: 200, body: { version: '1.0.0' } },
          'https://api.deepseek.com': { status: 200, body: { data: [{ id: 'deepseek-v4-flash' }] } },
          [glmSearch]: { status: 200, body: { search_result: [] } },
        }),
      }),
    );
    expect(find(ok, 'searchEndpoint')?.level).toBe('ok');

    const auth = await collectDoctor(
      input({
        offline: false,
        env: { DEEPSEEK_API_KEY: 'sk-x', ZHIPU_API_KEY: 'glm-key-123456' },
        fetchImpl: fakeFetch({
          [registry]: { status: 200, body: { version: '1.0.0' } },
          'https://api.deepseek.com': { status: 200, body: { data: [{ id: 'deepseek-v4-flash' }] } },
          [glmSearch]: { status: 401 },
        }),
      }),
    );
    expect(find(auth, 'searchEndpoint')?.level).toBe('fail');
  });
});

describe('LSP 分节', () => {
  it('列出合并后的每个服务器;PATH 上没有 → 内置报 info', async () => {
    const report = await collectDoctor(input()); // env 里没有 PATH,谁都找不到
    const section = report.sections.find((s) => s.id === 'lsp');
    expect(section).toBeDefined();
    expect(section!.checks.map((c) => c.id).sort()).toEqual([
      'lsp:gopls',
      'lsp:pyright',
      'lsp:rust-analyzer',
      'lsp:typescript',
    ]);
    const ts = find(report, 'lsp:typescript');
    expect(ts?.level).toBe('info'); // 内置服务器缺席是常态,不该告警
    expect(ts?.detail).toContain('typescript-language-server');
    expect(ts?.detail).toContain('not installed');
  });

  it('命令在 PATH 上时报 ok 并给出解析路径与扩展名', async () => {
    // 造一个真实可执行文件当命令(node 自己就是现成的可执行文件)。
    const binDir = path.join(dir, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    const fakeBin = path.join(binDir, 'gopls');
    await fs.writeFile(fakeBin, '#!/bin/sh\n', { mode: 0o755 });
    const report = await collectDoctor(
      input({ env: { DEEPSEEK_API_KEY: 'sk-x', PATH: binDir } }),
    );
    const gopls = find(report, 'lsp:gopls');
    expect(gopls?.level).toBe('ok');
    expect(gopls?.detail).toContain(fakeBin);
    expect(gopls?.detail).toContain('.go');
  });

  it('用户显式配置的命令缺失 → warn 带修复提示;enabled:false 的条目不出现', async () => {
    const config = configSchema.parse({
      provider: 'deepseek',
      lsp: {
        servers: {
          clangd: { command: 'clangd-definitely-missing', extensions: ['.c'] },
          typescript: { enabled: false },
        },
      },
    });
    const report = await collectDoctor(input({ config }));
    const clangd = find(report, 'lsp:clangd');
    expect(clangd?.level).toBe('warn');
    expect(clangd?.hint).toContain('lsp.servers.clangd');
    expect(find(report, 'lsp:typescript')).toBeUndefined();
  });

  it('lsp.enabled: false → 单条 info,不逐个列服务器', async () => {
    const config = configSchema.parse({ provider: 'deepseek', lsp: { enabled: false } });
    const report = await collectDoctor(input({ config }));
    expect(find(report, 'lspStatus')?.level).toBe('info');
    expect(find(report, 'lspStatus')?.detail).toContain('lsp.enabled: false');
    expect(find(report, 'lsp:typescript')).toBeUndefined();
  });
});

describe('LSP 真握手探测', () => {
  // 只查 PATH 抓不住"装了个坏的":命令在、起不来,才是最需要 doctor 说话的时候。
  async function makeBin(name: string, script: string) {
    const binDir = path.join(dir, 'lsp-bin');
    await fs.mkdir(binDir, { recursive: true });
    const file = path.join(binDir, name);
    await fs.writeFile(file, script, { mode: 0o755 });
    return binDir;
  }
  const probeConfig = () =>
    configSchema.parse({
      provider: 'deepseek',
      lsp: { servers: { probe: { command: 'probe-lsp', extensions: ['.zz'] } } },
    });

  it('起得来的服务器报握手耗时;探完即杀不留子进程', async () => {
    const fake = new URL('./support/fake-lsp.mjs', import.meta.url).pathname;
    const binDir = await makeBin('probe-lsp', `#!/bin/sh\nexec "${process.execPath}" "${fake}"\n`);
    const report = await collectDoctor(
      input({
        offline: false,
        config: probeConfig(),
        env: { DEEPSEEK_API_KEY: 'sk-x', PATH: binDir },
        fetchImpl: fakeFetch({
          'https://registry.npmjs.org': { status: 200, body: { version: '1.0.0' } },
          'https://api.deepseek.com': { status: 200, body: { data: [{ id: 'm' }] } },
        }),
      }),
    );
    const check = find(report, 'lsp:probe');
    expect(check?.level).toBe('ok');
    expect(check?.detail).toMatch(/handshake OK · \d+ms/);
  }, 20_000);

  it('命令存在但握手失败 → warn 带排查提示,而不是照报绿', async () => {
    const binDir = await makeBin('probe-lsp', '#!/bin/sh\nexit 1\n');
    const report = await collectDoctor(
      input({
        offline: false,
        config: probeConfig(),
        env: { DEEPSEEK_API_KEY: 'sk-x', PATH: binDir },
        fetchImpl: fakeFetch({
          'https://registry.npmjs.org': { status: 200, body: { version: '1.0.0' } },
          'https://api.deepseek.com': { status: 200, body: { data: [{ id: 'm' }] } },
        }),
      }),
    );
    const check = find(report, 'lsp:probe');
    expect(check?.level).toBe('warn');
    expect(check?.detail).toContain('handshake failed');
    expect(check?.hint).toContain('probe-lsp');
  }, 20_000);

  it('offline 跳过探测,只报存在性', async () => {
    const binDir = await makeBin('probe-lsp', '#!/bin/sh\nexit 1\n');
    const report = await collectDoctor(
      input({ config: probeConfig(), env: { DEEPSEEK_API_KEY: 'sk-x', PATH: binDir } }),
    );
    const check = find(report, 'lsp:probe');
    expect(check?.level).toBe('ok');
    expect(check?.detail).toContain('--offline');
  });

  // 会话内体检绝不为一个还没被触发的服务器去拉一个真语言服务器(rust-analyzer
  // 会连带 cargo 子进程)。用一个握手必失败的命令验证:若真拉起了会是 warn,
  // 拿到 ok 就证明没拉。
  it('会话内(known 非空)对未启动的服务器不做握手,只报已安装', async () => {
    const binDir = await makeBin('probe-lsp', '#!/bin/sh\nexit 1\n');
    const report = await collectDoctor(
      input({
        offline: false,
        config: probeConfig(),
        env: { DEEPSEEK_API_KEY: 'sk-x', PATH: binDir },
        lspStatuses: [], // 会话已启动、但这个服务器还没被任何编辑触发
        fetchImpl: fakeFetch({
          'https://registry.npmjs.org': { status: 200, body: { version: '1.0.0' } },
          'https://api.deepseek.com': { status: 200, body: { data: [{ id: 'm' }] } },
        }),
      }),
    );
    const check = find(report, 'lsp:probe');
    expect(check?.level).toBe('ok');
    expect(check?.detail).toContain('not started this session');
  });

  it('会话给了运行状态就采信,不再拉起:failed → warn', async () => {
    const binDir = await makeBin('probe-lsp', '#!/bin/sh\nexit 1\n');
    const report = await collectDoctor(
      input({
        offline: false,
        config: probeConfig(),
        env: { DEEPSEEK_API_KEY: 'sk-x', PATH: binDir },
        lspStatuses: [{ id: 'probe', state: 'failed' }],
        fetchImpl: fakeFetch({
          'https://registry.npmjs.org': { status: 200, body: { version: '1.0.0' } },
          'https://api.deepseek.com': { status: 200, body: { data: [{ id: 'm' }] } },
        }),
      }),
    );
    const check = find(report, 'lsp:probe');
    expect(check?.level).toBe('warn');
    expect(check?.detail).toContain('failed to start during this session');
  });
});

describe('skills 检查', () => {
  // 家目录也要指进临时目录:发现会扫 ~/.mojocode/skills 与 ~/.claude/skills,
  // 不 mock 的话开发者机器上的真实技能会渗进计数断言。
  beforeEach(() => {
    vi.stubEnv('HOME', dir);
    vi.stubEnv('USERPROFILE', dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('无技能:count 为 info,detail 提示 none', async () => {
    const report = await collectDoctor(input());
    const count = find(report, 'skills.count');
    expect(count?.level).toBe('info');
    expect(count?.detail).toContain('none');
    expect(find(report, 'skills.parse')).toBeUndefined();
  });

  it('有技能与解析失败:计数正确,失败列 warn', async () => {
    const skillsDir = path.join(dir, '.mojocode', 'skills');
    await fs.mkdir(path.join(skillsDir, 'good'), { recursive: true });
    await fs.writeFile(
      path.join(skillsDir, 'good', 'SKILL.md'),
      '---\ndescription: a fine skill\ndisable-model-invocation: true\n---\nbody\n',
    );
    await fs.mkdir(path.join(skillsDir, 'broken'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'broken', 'SKILL.md'), '---\nname: broken\n---\n');

    const report = await collectDoctor(input());
    const count = find(report, 'skills.count');
    expect(count?.detail).toContain('1 skills');
    expect(count?.detail).toContain('1 user-invocable');
    expect(count?.detail).toContain('0 model-invocable');
    const sources = find(report, 'skills.sources');
    expect(sources?.detail).toContain(skillsDir);
    const parse = find(report, 'skills.parse');
    expect(parse?.level).toBe('warn');
    expect(parse?.detail).toContain('broken');
    expect(parse?.detail).toContain('description');
  });
});
