import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
