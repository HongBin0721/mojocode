import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { App } from '../src/ui/App.js';
import { stubGoal } from './support/goal.js';
import { EventBus } from '../src/core/events.js';
import { configSchema } from '../src/config/schema.js';
import { setLocale } from '../src/i18n/index.js';
import type { Session } from '../src/app/bootstrap.js';
import type { McpStatus } from '../src/mcp/client.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

// 这一组比别的 UI 测试重:每次 /doctor 都真的去读文件系统(配置、会话目录、
// 工作区),再让 Ink 渲染整份三十来行的报告。默认的 5s 在全量并行时不够。
vi.setConfig({ testTimeout: 20_000 });

let root: string;

beforeEach(async () => {
  setLocale('en');
  // 有 key 才走得到端点那一行(缺 key 时 provider 分节到此为止)。
  vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test-key-value');
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-app-doctor-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * 覆盖 TUI 的 /doctor:它读会话此刻的配置,并直接采信已连上的 MCP 状态,
 * 不自己再连一遍(否则每个 stdio server 的子进程会被多拉起一份)。
 */
function setup(overrides: { config?: Record<string, unknown>; mcpStatuses?: McpStatus[] } = {}) {
  const bus = new EventBus();
  const provider = { id: 'test', label: 'Test', model: 'test-model', contextWindow: 100_000 };
  const run = vi.fn(async () => {});
  const session = {
    root,
    config: configSchema.parse({ provider: 'deepseek', ...overrides.config }),
    provider,
    agent: {
      isRunning: false,
      isCompacting: false,
      inject: () => false,
      run,
      abort: () => {},
      clear: () => {},
      compact: async () => {},
    },
    bus,
    gate: { setAsker: () => {} },
    todos: { get: () => [], subscribe: () => () => {} },
    goal: stubGoal(run),
    mcpStatuses: overrides.mcpStatuses ?? [],
    store: { id: 'test-session', messages: [] },
    switch: () => provider,
    setMode: () => {},
    refreshEnvironment: async () => {},
    dispose: async () => {},
  } as unknown as Session;

  const view = render(<App session={session} />);
  return { bus, ...view };
}

async function submit(stdin: { write: (s: string) => void }, text: string) {
  stdin.write(text);
  await tick();
  stdin.write('\r');
  await tick();
  await tick();
}

describe('/doctor 命令', () => {
  it('把体检报告写进时间线,含分节与汇总', async () => {
    const { stdin, frames, unmount } = setup();
    await submit(stdin, '/doctor offline');

    const out = frames.join('\n');
    expect(out).toContain('Environment');
    expect(out).toContain('Workspace');
    expect(out).toMatch(/\d+ ok/);
    unmount();
  });

  it('offline 参数下不做联网检查', async () => {
    const { stdin, frames, unmount } = setup();
    await submit(stdin, '/doctor offline');

    expect(frames.join('\n')).toContain('--offline');
    unmount();
  });

  it('采信已连上的 MCP 状态,不重新连接(命令根本不存在也照样是 ✓)', async () => {
    const { stdin, frames, unmount } = setup({
      config: {
        mcpServers: { demo: { type: 'stdio', command: 'definitely-not-a-real-binary', args: [] } },
      },
      mcpStatuses: [{ name: 'demo', connected: true, toolCount: 3 }],
    });
    await submit(stdin, '/doctor offline');

    const out = frames.join('\n');
    expect(out).toContain('demo');
    expect(out).toContain('3 tools');
    unmount();
  });

  it('报告反映会话此刻的权限档位,而不是磁盘上的配置', async () => {
    const { stdin, frames, unmount } = setup({ config: { sandbox: 'danger-full-access' } });
    await submit(stdin, '/doctor offline');

    expect(frames.join('\n')).toContain('danger-full-access');
    unmount();
  });
});
