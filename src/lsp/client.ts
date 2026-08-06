/**
 * 极简 LSP 客户端:JSON-RPC 2.0 over stdio(Content-Length 分帧)。
 *
 * 只实现诊断回喂需要的最小面:initialize 握手、didOpen/didChange 全文同步、
 * 收集 textDocument/publishDiagnostics。服务器发来的反向请求(workspace/
 * configuration、client/registerCapability 等)一律以空结果应答——不应答的话
 * 不少服务器会停在那里等,诊断永远不来。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** LSP 诊断的最小子集,字段名与协议一致。 */
export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  /** 1=Error 2=Warning 3=Info 4=Hint;协议规定缺省时客户端应视为 Error。 */
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface DiagnosticsWaiter {
  version: number;
  /** 收到一批该文件的诊断。由 waiter 自己决定就此收工还是继续等。 */
  publish: (diags: LspDiagnostic[]) => void;
  /** 服务器死了:以"不知道"收场,并清掉自己的计时器。 */
  fail: () => void;
}

/**
 * 收到**空**诊断后额外等一小会儿,看有没有后续批次。
 *
 * typescript-language-server 会把语法/语义/建议三轮合并成一批发出(实测
 * 5.3 对同一版本只发一次),但 rust-analyzer(cargo check 流式出结果)和
 * gopls(按包检查)会先发一个空批次占位、真正的错误稍后才到。当场收工
 * 就会把"有错"报成"干净"——那正是这个功能最不能出的错。
 *
 * 只在空批次上付这个等待:有错的时候立刻返回,不拖慢常见路径。
 */
const EMPTY_GRACE_MS = 400;

export interface LspClientOptions {
  command: string;
  args: string[];
  root: string;
  /** initialize 握手的超时,只在服务器首次拉起时付一次。 */
  initTimeoutMs?: number;
}

export class LspClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  /** uri(解码后) → 已发送的最新文档版本。0 未打开。 */
  private versions = new Map<string, number>();
  private waiters = new Map<string, DiagnosticsWaiter[]>();
  private readonly initPromise: Promise<void>;
  /** 进程拉不起来/半路死掉/握手失败。manager 据此本会话不再重试。 */
  failed = false;

  constructor(private options: LspClientOptions) {
    this.child = spawn(options.command, options.args, {
      cwd: options.root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    // stderr 只消费不保留:留着不读会因背压堵住某些服务器。
    this.child.stderr.resume();
    // 三个流都要挂 error 监听。尤其是 stdin:服务器在我们的字节还排在管道里
    // 时死掉(rust-analyzer 被 OOM kill、或者干脆是被这条 didChange 搞崩的),
    // Node 会在 stdin 上抛 EPIPE——没人听就是未捕获异常,整个 TUI 当场退出,
    // 用户丢掉这一轮。writable 判断挡不住:错误发生在 flush 时,那时 send()
    // 早已返回,而 'exit' 事件还没送到。
    this.child.stdin.on('error', () => this.fail(new Error(`${options.command} stdin closed`)));
    this.child.stdout.on('error', () => this.fail(new Error(`${options.command} stdout closed`)));
    this.child.stderr.on('error', () => {});
    this.child.on('error', (err) => this.fail(err));
    this.child.on('exit', () => this.fail(new Error(`${options.command} exited`)));
    this.initPromise = this.initialize();
    // 失败在 diagnose 处按需重抛;这里兜住避免 unhandled rejection。
    this.initPromise.catch(() => {});
  }

  /**
   * 把一份文件内容交给服务器并等它发回该文件的诊断。
   * 返回 null 表示超时——"不知道"而不是"没问题",调用方应当沉默。
   */
  async diagnose(
    absolutePath: string,
    languageId: string,
    text: string,
    timeoutMs: number,
  ): Promise<LspDiagnostic[] | null> {
    await this.initPromise;
    // 握手成功之后死掉的服务器:早点抛,manager 才能把它记死。不抛的话
    // send() 静默丢弃、诊断永远不来,此后每次 write/edit 都要白等一个
    // 完整的 timeoutMs。
    if (this.failed) throw new Error(`${this.options.command} is not available`);

    const uri = pathToFileURL(absolutePath).href;
    const key = decodeURIComponent(uri);
    const version = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, version);

    // 先挂 waiter 再发通知,免得诊断在两步之间到达而没人接。
    const wait = new Promise<LspDiagnostic[] | null>((resolve) => {
      let timeout: NodeJS.Timeout;
      let graceTimer: NodeJS.Timeout | undefined;

      // 计时器一律清干净:cli.tsx 有意不调用 process.exit(只设 exitCode),
      // 留着的计时器会把 `mojocode -p` 的退出硬生生拖上好几秒。
      const settle = (value: LspDiagnostic[] | null): void => {
        clearTimeout(timeout);
        if (graceTimer) clearTimeout(graceTimer);
        const current = this.waiters.get(key);
        const idx = current?.indexOf(waiter) ?? -1;
        if (current && idx !== -1) current.splice(idx, 1);
        resolve(value);
      };

      const waiter: DiagnosticsWaiter = {
        version,
        publish: (diags) => {
          if (diags.length > 0) {
            settle(diags);
            return;
          }
          // 空批次:宽限一次,等可能的后续批次(见 EMPTY_GRACE_MS)。
          // 宽限期内再来空批次不续期,总时长仍受 timeoutMs 约束。
          if (graceTimer) return;
          graceTimer = setTimeout(() => settle(diags), Math.min(EMPTY_GRACE_MS, timeoutMs));
          graceTimer.unref();
        },
        fail: () => settle(null),
      };

      timeout = setTimeout(() => settle(null), timeoutMs);
      timeout.unref();
      const list = this.waiters.get(key) ?? [];
      list.push(waiter);
      this.waiters.set(key, list);
    });

    if (version === 1) {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } });
    } else {
      // 不带 range 的 contentChange 即全文替换,增量同步的服务器也接受。
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    return wait;
  }

  async dispose(): Promise<void> {
    if (!this.failed) {
      try {
        await this.request('shutdown', null, 1000);
        this.notify('exit', undefined);
      } catch {
        // 关不掉就直接杀,不能让退出流程被一个僵死的服务器拖住。
      }
    }
    this.child.kill();
  }

  private async initialize(): Promise<void> {
    const rootUri = pathToFileURL(this.options.root).href;
    try {
      await this.request(
        'initialize',
        {
          processId: process.pid,
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
          capabilities: {
            textDocument: {
              synchronization: { didSave: false },
              publishDiagnostics: { relatedInformation: false },
            },
            workspace: { workspaceFolders: true },
          },
        },
        this.options.initTimeoutMs ?? 10_000,
      );
      this.notify('initialized', {});
    } catch (err) {
      this.fail(err as Error);
      throw err;
    }
  }

  private fail(err: Error): void {
    if (this.failed) return;
    this.failed = true;
    for (const [, req] of this.pending) req.reject(err);
    this.pending.clear();
    // 等着诊断的调用以"不知道"收场,而不是永远挂着。
    for (const [, list] of this.waiters) for (const w of [...list]) w.fail();
    this.waiters.clear();
    this.child.kill();
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.failed) {
        reject(new Error(`${this.options.command} unavailable`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(message: RpcMessage): void {
    if (this.failed || !this.child.stdin.writable) return;
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        // 帧头坏了,没法继续对齐,只能放弃这个服务器。
        this.fail(new Error(`${this.options.command} sent a malformed frame`));
        return;
      }
      const length = Number(match[1]);
      const total = headerEnd + 4 + length;
      if (this.buffer.length < total) return;
      const body = this.buffer.subarray(headerEnd + 4, total).toString('utf8');
      this.buffer = this.buffer.subarray(total);
      try {
        this.dispatch(JSON.parse(body) as RpcMessage);
      } catch {
        // 单条消息解析失败不致命,分帧仍然对齐。
      }
    }
  }

  private dispatch(message: RpcMessage): void {
    // 服务器发来的反向请求:一律空结果应答(configuration 要按条目数给 null)。
    if (message.method !== undefined && message.id !== undefined) {
      const result =
        message.method === 'workspace/configuration'
          ? ((message.params as { items?: unknown[] } | undefined)?.items ?? []).map(() => null)
          : null;
      this.send({ jsonrpc: '2.0', id: message.id, result });
      return;
    }
    // 通知:只关心诊断。
    if (message.method === 'textDocument/publishDiagnostics') {
      this.onDiagnostics(
        message.params as { uri: string; version?: number; diagnostics: LspDiagnostic[] },
      );
      return;
    }
    // 我们发出的请求的应答。
    if (message.id !== undefined && typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
  }

  private onDiagnostics(params: { uri: string; version?: number; diagnostics: LspDiagnostic[] }): void {
    const key = decodeURIComponent(params.uri);
    const list = this.waiters.get(key);
    if (!list || list.length === 0) return;
    // publish 会就地把已收工的 waiter 从 this.waiters 里摘掉(settle),
    // 所以遍历前先拷一份,免得边遍历边改。
    for (const waiter of [...list]) {
      // 带版本的诊断落后于我们发出的版本时,是旧内容的余波,继续等新的。
      // (注意 tsls 压根不发 version 字段,这一条对它不生效。)
      if (params.version !== undefined && params.version < waiter.version) continue;
      waiter.publish(params.diagnostics ?? []);
    }
  }
}
