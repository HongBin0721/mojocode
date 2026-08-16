/**
 * LSP 诊断的统一入口:write/edit 成功后调 `check()`,把该文件的错误/警告
 * 格式化成英文行回喂给模型(与工具结果一致,不做本地化——见 i18n 的约定)。
 *
 * 一切失败都静默降级为 undefined:没装服务器、拉起失败、握手超时、诊断
 * 超时……诊断是锦上添花,绝不能让 write/edit 因它报错。服务器按 id 惰性
 * 拉起,起不来的记为 null,本会话不再重试。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LspClient, type LspDiagnostic } from './client.js';
import {
  BUILTIN_LSP_SERVERS,
  DEFAULT_EMPTY_GRACE_MS,
  languageIdFor,
  type LspServerDef,
} from './servers.js';
import type { LspConfig } from '../config/schema.js';

export interface LspCheckResult {
  errors: number;
  warnings: number;
  /** 已格式化的诊断行(如 `12:5 error: Cannot find name 'x' (typescript 2304)`)。 */
  items: string[];
  /**
   * 本次检查期间冒出新问题的**其他已检查过的文件**——改了 A 的签名,B 的
   * 调用点炸了。每行如 `src/b.ts: 2 errors, 1 warning`,细节让模型自己去读。
   */
  otherFiles?: string[];
}

/** 会话内各服务器的运行状态,doctor 用(有则采信,不再重复拉起)。 */
export interface LspRuntimeStatus {
  id: string;
  state: 'ok' | 'failed';
}

/** 单次回喂最多带多少条诊断——一个坏改动能炸出几百条,全带上只会淹掉重点。 */
const MAX_ITEMS = 20;
/** timeoutMs 之外再宽限这么久,留给首次调用的服务器握手。doctor 的握手探针也用它拼同款预算。 */
export const HANDSHAKE_GRACE_MS = 5000;
/** 单条消息的长度上限(rust-analyzer 的多行长解释常见)。 */
const MAX_MESSAGE_CHARS = 500;

export class LspManager {
  /** serverId → 客户端;null = 拉起失败过,别再试。 */
  private clients = new Map<string, LspClient | null>();

  constructor(
    private root: string,
    private config: LspConfig,
  ) {}

  /**
   * 检查一份刚写入的内容。undefined = 干净或无从判断,两者都无需打扰模型。
   *
   * 整个过程绝不抛错:spawn 对畸形命令(配置里带空字节之类)是**同步**抛的,
   * 漏出去就会把一次已经成功的写入变成工具报错——正是文件头那条不变量
   * 不允许的事。
   */
  async check(absolutePath: string, content: string): Promise<LspCheckResult | undefined> {
    try {
      return await this.runCheck(absolutePath, content);
    } catch {
      return undefined;
    }
  }

  private async runCheck(
    absolutePath: string,
    content: string,
  ): Promise<LspCheckResult | undefined> {
    if (!this.config.enabled) return undefined;
    // 扩展名统一小写:serverFor 与 languageIdFor 必须看同一个值,否则
    // 写 `Foo.TS` 会匹配上服务器却拿到 languageId "TS",服务器不认这门
    // 语言,诊断永远不来,白等一个 timeoutMs。
    const ext = path.extname(absolutePath).toLowerCase();
    const def = this.serverFor(ext);
    if (!def) return undefined;

    let client = this.clients.get(def.id);
    if (client === null) return undefined;

    try {
      if (!client) {
        client = new LspClient({ command: def.command, args: def.args, root: this.root });
        this.clients.set(def.id, client);
      }
      // 总时长再加一道硬上限:首次调用要付服务器握手的钱,但一个僵死的
      // 服务器不能把 write/edit 拖住十几秒——超限就放弃,握手在后台继续,
      // 下一次调用多半就能用上了。
      const outcome = await withCap(
        client.diagnose(absolutePath, languageIdFor(ext), content, {
          timeoutMs: this.config.timeoutMs,
          graceMs: def.emptyGraceMs,
        }),
        this.config.timeoutMs + HANDSHAKE_GRACE_MS,
      );
      // withCap 硬超时(outcome=null):连 others 都没得报,直接放弃。
      if (outcome === null) return undefined;
      // 本文件自己的诊断超时了(diagnostics=null),但波及到的 B 可能已经在
      // 等待期间到齐——那份观察不能一起丢掉,否则"这次改动炸了 B"就没人知道。
      const otherFiles = this.formatOthers(outcome.others);
      if (outcome.diagnostics === null) {
        if (client.failed) this.clients.set(def.id, null);
        return otherFiles.length > 0
          ? { errors: 0, warnings: 0, items: [], otherFiles }
          : undefined;
      }
      const primary = formatDiagnostics(outcome.diagnostics);
      // 本文件干净且没波及别人才沉默;本文件干净但改炸了 B,必须出声。
      if (!primary && otherFiles.length === 0) return undefined;
      return {
        errors: primary?.errors ?? 0,
        warnings: primary?.warnings ?? 0,
        items: primary?.items ?? [],
        ...(otherFiles.length > 0 ? { otherFiles } : {}),
      };
    } catch {
      if (!client || client.failed) this.clients.set(def.id, null);
      return undefined;
    }
  }

  /** 本次检查期间其他文件的新诊断 → `src/b.ts: 2 errors, 1 warning` 行。 */
  private formatOthers(others: Array<{ uri: string; diagnostics: LspDiagnostic[] }>): string[] {
    const lines: string[] = [];
    for (const other of others) {
      const formatted = formatDiagnostics(other.diagnostics);
      if (!formatted) continue; // 波及后反而干净了(顺手修好)不必出声
      let relative: string;
      try {
        relative = path.relative(this.root, fileURLToPath(other.uri));
      } catch {
        continue;
      }
      const parts = [
        formatted.errors > 0 ? `${formatted.errors} error${formatted.errors > 1 ? 's' : ''}` : '',
        formatted.warnings > 0
          ? `${formatted.warnings} warning${formatted.warnings > 1 ? 's' : ''}`
          : '',
      ].filter(Boolean);
      lines.push(`${relative}: ${parts.join(', ')} (this edit may have broken it — read it to check)`);
    }
    return lines;
  }

  /** 会话内已拉起过的服务器状态。doctor 有则采信,不再重复拉起。 */
  statuses(): LspRuntimeStatus[] {
    return [...this.clients.entries()].map(([id, client]) => ({
      id,
      state: client === null || client.failed ? ('failed' as const) : ('ok' as const),
    }));
  }

  async dispose(): Promise<void> {
    const clients = [...this.clients.values()].filter((c): c is LspClient => c instanceof LspClient);
    this.clients.clear();
    await Promise.all(clients.map((c) => c.dispose()));
  }

  /** 内置注册表与用户配置合并后,按(已小写的)扩展名找接管的服务器。 */
  private serverFor(ext: string): LspServerDef | undefined {
    if (!ext) return undefined;
    for (const def of resolveLspServers(this.config)) {
      if (def.extensions.includes(ext)) return def;
    }
    return undefined;
  }
}

/** 内置注册表与用户配置的合并结果。manager 按它派发,doctor 按它列出可用性。 */
export function resolveLspServers(config: LspConfig): LspServerDef[] {
  const map = new Map<string, LspServerDef>(BUILTIN_LSP_SERVERS.map((d) => [d.id, d]));
  for (const [id, override] of Object.entries(config.servers)) {
    if (override.enabled === false) {
      map.delete(id);
      continue;
    }
    const base = map.get(id);
    const def: LspServerDef = {
      id,
      command: override.command ?? base?.command ?? '',
      args: override.args ?? base?.args ?? [],
      extensions: (override.extensions ?? base?.extensions ?? []).map((e) => e.toLowerCase()),
      emptyGraceMs: override.graceMs ?? base?.emptyGraceMs ?? DEFAULT_EMPTY_GRACE_MS,
    };
    // 自定义条目缺 command 或 extensions 时无从工作,静默忽略。
    if (!def.command || def.extensions.length === 0) continue;
    map.set(id, def);
  }
  return [...map.values()];
}

/**
 * 给一个 promise 加硬超时。计时器必须清掉:cli.tsx 有意不调用 process.exit,
 * 挂着的计时器会让 `mojocode -p` 在最后一次写入后干等好几秒才退出。
 */
async function withCap<T>(promise: Promise<T>, capMs: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  // 超时先返回、promise 之后才失败的情形:没这一句就是未捕获的 rejection。
  // (race 仍然看得到这次失败,这里只是给原 promise 挂上处理器。)
  void promise.catch(() => {});
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), capMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 只保留 error/warning(缺省按协议视为 error),info/hint 是噪音。 */
function formatDiagnostics(diags: LspDiagnostic[]): LspCheckResult | undefined {
  const relevant = diags
    .filter((d) => d.severity === undefined || d.severity === 1 || d.severity === 2)
    .sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  if (relevant.length === 0) return undefined;

  let errors = 0;
  let warnings = 0;
  const items: string[] = [];
  for (const d of relevant) {
    const isWarning = d.severity === 2;
    if (isWarning) warnings += 1;
    else errors += 1;
    if (items.length >= MAX_ITEMS) continue;
    const loc = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
    const origin = [d.source, d.code !== undefined ? String(d.code) : undefined]
      .filter(Boolean)
      .join(' ');
    const message = d.message.length > MAX_MESSAGE_CHARS
      ? `${d.message.slice(0, MAX_MESSAGE_CHARS)}…`
      : d.message;
    items.push(`${loc} ${isWarning ? 'warning' : 'error'}: ${message}${origin ? ` (${origin})` : ''}`);
  }
  const hidden = relevant.length - items.length;
  if (hidden > 0) items.push(`… ${hidden} more not shown`);
  return { errors, warnings, items };
}
