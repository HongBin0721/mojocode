import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 真的把 `serve --managed` 当子进程拉起来,带上父进程会转发的每一个 flag,
 * 等到握手行为止。
 *
 * 它守的是「子进程拒绝父进程传来的 flag」这一类回归。`serve` 子命令上的
 * `--managed` 曾在一次编辑里被顺手删掉,全套测试照样绿——没有一处测试以
 * `serve --managed` 拉起真进程,`server.test.ts` 直接调 `startServer`,
 * `bootstrap-extensions.test.ts` 直接调 `bootstrap`,commander 那层根本没
 * 被走过;而用户看到的是 TUI 一启动就「无法启动 mojocode server」。
 *
 * 子进程用 Bun 跑源码(`bun src/cli.tsx`),不依赖 `dist/`:CI 的每个 job
 * 都先跑测试再 build。jiti 的 register 钩子解析不了 cli.tsx(在第 7 行的
 * `type` 内联导入上报 ParseError),所以 Node lane 也借本机的 bun;没有 bun
 * 的环境(CI 的 Node job)整体跳过——Bun lane 的 `bun --bun x vitest run`
 * 会在 CI 里把它跑到。
 *
 * flag 集合镜像 `cli.tsx` 的 `serveArgsFrom`(GUI 侧 `session-service.ts` /
 * `task-manager.ts` 转发的是它的子集)。`--resume` / `--fork-session` 要先有
 * 一个会话,不在这里考。
 */

const BUN = process.versions.bun ? process.execPath : bunOnPath();

function bunOnPath(): string | undefined {
  try {
    execSync('bun --version', { stdio: 'ignore' });
    return 'bun';
  } catch {
    return undefined;
  }
}

const HANDSHAKE_TIMEOUT_MS = 30_000;

let home: string;
let root: string;
let extensionFile: string;
let marker: string;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-serve-home-'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mojocode-serve-root-'));
  // `-e` 指向的扩展在 setup 里落一个标记文件:证明 flag 不只被 commander 接受,
  // 还真的一路传到了 bootstrap。
  marker = path.join(root, 'probe-loaded.txt');
  extensionFile = path.join(root, 'probe.ts');
  await fs.writeFile(
    extensionFile,
    `import { writeFileSync } from 'node:fs';\nexport default (api) => { writeFileSync(${JSON.stringify(marker)}, api.id); };\n`,
  );
});

afterAll(async () => {
  for (const dir of [home, root]) await fs.rm(dir, { recursive: true, force: true });
});

describe.skipIf(!BUN)('serve --managed 子进程', () => {
  it(
    '接受父进程会转发的每一个 flag,握手后随 stdin 关闭而退出',
    async () => {
      const args = [
        path.resolve('src/cli.tsx'),
        'serve',
        '--managed',
        // ↓ 与 serveArgsFrom 的顺序一致
        '--cwd',
        root,
        '--provider',
        'deepseek',
        '--model',
        'test-model',
        '--max-context',
        '50000',
        '--max-steps',
        '3',
        '--no-mcp',
        '--extension',
        extensionFile,
        '--search-backend',
        'off',
      ];
      const child = spawn(BUN!, args, {
        cwd: root,
        env: { ...process.env, HOME: home, DEEPSEEK_API_KEY: 'test-key-not-used' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => {
        stderr += chunk;
      });

      // 与 server-launch.ts 同一套握手:stdout 上第一行能 JSON.parse 出 url 的。
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`handshake timeout\n--- stderr ---\n${stderr}`));
        }, HANDSHAKE_TIMEOUT_MS);
        let buffer = '';
        child.stdout!.setEncoding('utf8');
        child.stdout!.on('data', (chunk: string) => {
          buffer += chunk;
          for (const line of buffer.split('\n').slice(0, -1)) {
            try {
              const parsed = JSON.parse(line) as { url?: string };
              if (typeof parsed.url === 'string') {
                clearTimeout(timer);
                resolve(parsed.url);
                return;
              }
            } catch {
              // 非握手行
            }
          }
          buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
        });
        child.once('exit', (code, signal) => {
          clearTimeout(timer);
          reject(new Error(`serve exited before handshake (code ${code}, signal ${signal})\n--- stderr ---\n${stderr}`));
        });
      });
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // `-e` 真的到了 bootstrap:扩展的 setup 跑过。
      expect(await fs.readFile(marker, 'utf8')).toBe('probe');

      // 父进程退出 = stdin 关闭 → 子进程自行收尾(runServe 的 stdin 'end' 路径)。
      const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
      child.stdin!.end();
      expect(await exit).toBe(0);
    },
    HANDSHAKE_TIMEOUT_MS + 10_000,
  );
});
