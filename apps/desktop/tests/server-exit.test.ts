/**
 * sidecar 意外退出的上报链测试:
 *  - spawn-server:握手后子进程退出 → onExit 携带退出码与 stderr 尾部
 *    (真子进程,fixture 脚本模拟握手 + 遗言 + 非零退出);
 *  - session-service:onExit → notifyServerExit(GUI 文案 + 尾部若干行),
 *    dispose 之后抑制;connect 收到 GUI 版断线文案(lostMessage)。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '@core/i18n';
import type { RemoteSession } from '@core/remote';
import { spawnManagedServer, type ServerExitInfo } from '../src/main/spawn-server.js';
import {
  startDesktopSession,
  type ConnectFn,
  type SpawnFn,
} from '../src/main/session-service.js';
import type { ServerRuntime } from '../src/main/resolve-runtime.js';

const waitFor = async (check: () => boolean, ms = 3000): Promise<void> => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

let cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn();
  cleanups = [];
});

describe('spawn-server 意外退出', () => {
  it('握手后子进程退出:onExit 携带退出码与 stderr 尾部', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mojocode-spawn-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const fixture = join(dir, 'fake-server.js');
    // 先握手,隔一拍再写 stderr——保证遗言落在握手之后的尾部缓冲里,
    // 而不是被握手前的原样转发路径吃掉。
    await writeFile(
      fixture,
      `process.stdout.write(JSON.stringify({ url: 'http://127.0.0.1:9' }) + '\\n');
setTimeout(() => {
  process.stderr.write('boom-line-1\\nboom-line-2\\n');
  setTimeout(() => process.exit(7), 50);
}, 50);
`,
    );

    const exits: ServerExitInfo[] = [];
    const spawned = await spawnManagedServer({
      nodeBin: process.execPath,
      cliJs: fixture,
      serveArgs: [],
      onExit: (info) => exits.push(info),
    });
    expect(spawned.url).toBe('http://127.0.0.1:9');

    await waitFor(() => exits.length === 1);
    expect(exits[0]!.code).toBe(7);
    expect(exits[0]!.stderrTail).toContain('boom-line-1');
    expect(exits[0]!.stderrTail).toContain('boom-line-2');
  });
});

describe('session-service 意外退出接线', () => {
  it('onExit → notifyServerExit(GUI 文案 + 尾部);dispose 之后抑制', async () => {
    let capturedExit: ((info: ServerExitInfo) => void) | undefined;
    const waitExit = vi.fn(async () => {});
    const spawnServer: SpawnFn = async (_runtime, _args, onExit) => {
      capturedExit = onExit;
      return { url: 'http://127.0.0.1:9', token: 'tok', waitExit };
    };
    const notify = vi.fn();
    const dispose = vi.fn(async () => {});
    let lostMessage: string | undefined;
    const connect: ConnectFn = async (options) => {
      lostMessage = options.lostMessage;
      return { notifyServerExit: notify, dispose } as unknown as RemoteSession;
    };
    // 全量尾部会倒到主进程 stderr,测试里静音并留证。
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    cleanups.push(() => stderrSpy.mockRestore());

    const desktop = await startDesktopSession({
      root: '/tmp/x',
      attach: undefined,
      runtime: { nodeBin: 'node', cliJs: 'cli.js', runAsNode: false } satisfies ServerRuntime,
      spawnServer,
      connect,
    });

    // 断线文案用 GUI 措辞,不是「重启 TUI」。
    expect(lostMessage).toBe(t('notice.serverLostApp'));

    capturedExit!({ code: 1, signal: null, stderrTail: ['line-a', 'line-b'] });
    expect(notify).toHaveBeenCalledTimes(1);
    const message = notify.mock.calls[0]![0] as string;
    expect(message).toContain('code 1');
    expect(message).toContain('line-a\nline-b');
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('line-a');

    // 计划内退出:dispose 置 disposing 后,exit 回调不再上报。
    await desktop.dispose();
    expect(dispose).toHaveBeenCalled();
    expect(waitExit).toHaveBeenCalled();
    capturedExit!({ code: 0, signal: null, stderrTail: [] });
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
