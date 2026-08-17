/**
 * GUI 拉起受管 server 子进程。握手协议与 TUI 侧的 src/app/server-launch.ts
 * 完全一致(那边硬编码 process.execPath / process.argv[1],GUI 的进程形态
 * 不同——dev 用系统 node、打包用 ELECTRON_RUN_AS_NODE——所以镜像一份而
 * 不是参数化共用,避免 TUI 路径为 GUI 需求开口子):
 *
 *  - token 由本进程生成、经 **MOJOCODE_SERVER_TOKEN 环境变量**传入(不走
 *    argv——ps 对所有本机用户可见);
 *  - 子进程 `serve --managed` 就绪后向 stdout 写一行 `{"url":...}`;
 *  - 子进程持有本进程的 stdin 管道,父进程退出 → 管道关闭 → 子进程自行收尾
 *    (server 侧还有 ppid 看门狗兜底);
 *  - stderr:握手前原样转发(配置警告、MCP 连接失败都发生在 bootstrap 期),
 *    握手后进尾部环形缓冲,异常退出时倒出来排障。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/** bootstrap 可能要连多个 MCP server,握手上限给足(与 server-launch 对齐)。 */
const HANDSHAKE_TIMEOUT_MS = 120_000;
/** 握手后保留的 stderr 尾部行数(异常退出时的排障线索)。 */
const STDERR_TAIL_LINES = 50;

export interface SpawnedServer {
  url: string;
  token: string;
  /** dispose(shutdown RPC)后调用:限时等子进程退出,超时补刀。 */
  waitExit(graceMs?: number): Promise<void>;
}

/** 握手后子进程退出时回调携带的现场:退出码/信号 + stderr 尾部(死因线索)。 */
export interface ServerExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string[];
}

export interface SpawnServerParams {
  /** 跑 cli.js 的 Node 可执行文件(系统 node,或打包态的 ELECTRON_RUN_AS_NODE)。 */
  nodeBin: string;
  /** mojocode CLI 入口(dist/cli.js)。 */
  cliJs: string;
  /** 传给 serve 子命令的参数,如 ['--cwd', root]。 */
  serveArgs: string[];
  /** 打包态用 ELECTRON_RUN_AS_NODE 跑 Electron 自带的二进制。 */
  runAsNode?: boolean;
  /**
   * 握手**之后**子进程退出即触发(计划内 shutdown 也会——期望的退出由调用方
   * 吸收,见 session-service 的 disposing 标志)。没有它,sidecar 崩溃只
   * 表现为几秒后「连接断开」,stderr 尾部缓冲永远没人倒。
   */
  onExit?: (info: ServerExitInfo) => void;
}

export async function spawnManagedServer(params: SpawnServerParams): Promise<SpawnedServer> {
  const token = randomBytes(24).toString('hex');
  const { nodeBin, cliJs, serveArgs } = params;

  const child: ChildProcess = spawn(nodeBin, [cliJs, 'serve', '--managed', ...serveArgs], {
    env: params.runAsNode
      ? { ...process.env, MOJOCODE_SERVER_TOKEN: token, ELECTRON_RUN_AS_NODE: '1' }
      : { ...process.env, MOJOCODE_SERVER_TOKEN: token },
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
      reject(new Error(`拉起 server 失败:握手超时(${HANDSHAKE_TIMEOUT_MS / 1000}s)`));
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
          `拉起 server 失败:子进程退出(code ${code ?? '?'})${
            stderrTail.length ? `\n${stderrTail.join('\n')}` : ''
          }`,
        ),
      );
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`拉起 server 失败:${error.message}`));
    });
  });
  handshaken = true;
  // 握手内那个 once('exit') 已随 promise 落定失效;这里重新挂一个,把退出
  // 现场(含尾部缓冲快照)交给调用方倒出与上报。
  child.once('exit', (code, signal) => {
    params.onExit?.({ code, signal, stderrTail: [...stderrTail] });
  });

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
