/**
 * TUI 启动时拉起受管 server 子进程(对齐 opencode:TUI 永远是瘦客户端,
 * server 由它自动拉起,或经 `--attach` 连到外部已有实例)。
 *
 * 握手协议:子进程 `serve --managed` 在 bootstrap + 监听就绪后向 stdout 写
 * 一行 JSON `{"url":"http://127.0.0.1:<port>"}`;token 由父进程生成、经
 * **环境变量**传入(不走 argv——ps 对所有本机用户可见)。子进程持有父进程
 * 的 stdin 管道,父进程退出 → 管道关闭 → 子进程自行收尾(见 cli 的 serve
 * 动作),TUI 崩溃也不会留下孤儿 server。
 *
 * stderr 策略:握手完成前原样转发(配置警告、MCP 连接失败都发生在
 * bootstrap 期);握手后进入 alternate screen,转发会写花全屏,改存尾部
 * 环形缓冲,子进程异常退出时倒出来帮助定位。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { isCompiledBinary } from '../config/version.js';
import { t } from '../i18n/index.js';

/** bootstrap 可能要连多个 MCP server,握手上限给足。 */
const HANDSHAKE_TIMEOUT_MS = 120_000;
/** 握手后保留的 stderr 尾部行数(异常退出时的排障线索)。 */
const STDERR_TAIL_LINES = 50;

export interface SpawnedServer {
  url: string;
  token: string;
  /** dispose(shutdown RPC)后调用:限时等子进程退出,超时补刀。 */
  waitExit(graceMs?: number): Promise<void>;
}

export async function spawnManagedServer(serveArgs: string[]): Promise<SpawnedServer> {
  const token = randomBytes(24).toString('hex');
  // 单二进制:execPath 就是 mojocode 本体;Node:node + dist/cli.js。
  // 不带 execArgv:server 侧无 FFI,--experimental-ffi 等旗标无须继承。
  const argv = isCompiledBinary()
    ? [process.execPath, 'serve', '--managed', ...serveArgs]
    : [process.execPath, process.argv[1]!, 'serve', '--managed', ...serveArgs];

  const child: ChildProcess = spawn(argv[0]!, argv.slice(1), {
    env: { ...process.env, MOJOCODE_SERVER_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let handshaken = false;
  const stderrTail: string[] = [];
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    if (!handshaken) {
      process.stderr.write(chunk);
      return;
    }
    for (const line of chunk.split('\n')) {
      if (!line) continue;
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    }
  });

  const url = await new Promise<string>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(t('cli.serverSpawnFailed', { message: 'handshake timeout' })));
    }, HANDSHAKE_TIMEOUT_MS);

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        try {
          const parsed = JSON.parse(line) as { url?: string };
          if (typeof parsed.url === 'string') {
            clearTimeout(timer);
            resolve(parsed.url);
            return;
          }
        } catch {
          // 非握手行(意外输出)——继续等下一行。
        }
        newline = buffer.indexOf('\n');
      }
    });

    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          t('cli.serverSpawnFailed', {
            message: `server exited with code ${code ?? '?'}${stderrTail.length ? `\n${stderrTail.join('\n')}` : ''}`,
          }),
        ),
      );
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(t('cli.serverSpawnFailed', { message: error.message })));
    });
  });
  handshaken = true;

  return {
    url,
    token,
    waitExit: (graceMs = 3000) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, graceMs);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        // shutdown RPC 已发;补一手 stdin 关闭(受管退出的另一条触发路径)。
        child.stdin?.end();
      }),
  };
}
