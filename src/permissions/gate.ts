import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PermissionAsker, PermissionRequest, EventBus } from '../core/events.js';
import type { PermissionMode, PermissionRules } from '../config/schema.js';
import { projectConfigPath, projectDir } from '../config/paths.js';
import { judgeCommand, ruleToPrefix } from './bash-rules.js';
import { matchGlob } from './sandbox.js';
import { t } from '../i18n/index.js';

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

export interface GateOptions {
  root: string;
  mode: PermissionMode;
  rules: PermissionRules;
  ask: PermissionAsker;
  bus: EventBus;
}

/**
 * 决定一次工具调用是否可以继续。
 *
 * AI SDK 7 自带 `toolApproval` 机制,但它会挂起流,并要求调用方带着批准
 * 消息恢复——那是为客户端/服务器往返设计的。在 CLI 里循环由我们自己掌控,
 * 所以在 `execute()` 内部做门禁既更简单,也能在用户决定期间保持流不中断。
 */
export class PermissionGate {
  private readonly sessionAllowBash: string[] = [];
  private readonly sessionAllowWrite: string[] = [];

  constructor(private readonly options: GateOptions) {}

  get mode(): PermissionMode {
    return this.options.mode;
  }

  setMode(mode: PermissionMode): void {
    this.options.mode = mode;
  }

  /**
   * 替换批准回调。TUI 挂载后会安装自己的回调;在那之前用的是启动时的
   * headless 兜底回调(`-p` 模式则全程使用它)。
   */
  setAsker(ask: PermissionAsker): void {
    this.options.ask = ask;
  }

  /**
   * 在会修改状态的工具做任何工作之前调用。
   *
   * 与 `checkWrite` 分开,是因为工具会走捷径——`write` 在内容未变化时会
   * 提前返回——而 readonly 模式在这些路径上也必须成立,否则这条保证就
   * 取决于恰好执行了哪个分支。
   */
  assertCanMutate(what: string): void {
    if (this.options.mode === 'readonly') {
      throw new PermissionDeniedError(
        `Cannot modify ${what}: running in readonly mode. Restart without --readonly to allow edits.`,
      );
    }
  }

  async checkWrite(relativePath: string, detail?: string): Promise<void> {
    this.assertCanMutate(relativePath);
    if (this.options.mode === 'yolo' || this.options.mode === 'acceptEdits') return;

    const allowGlobs = [...this.options.rules.allowWrite, ...this.sessionAllowWrite];
    if (allowGlobs.some((glob) => matchGlob(glob, relativePath))) return;

    await this.request({
      id: randomUUID(),
      toolName: 'write',
      title: t('perm.writeTitle', { path: relativePath }),
      detail,
      suggestedRule: suggestWriteRule(relativePath),
      risk: 'write',
    });
  }

  async checkBash(command: string, cwdLabel: string): Promise<void> {
    const verdict = judgeCommand(command, {
      allow: [...this.options.rules.allowBash, ...this.sessionAllowBash],
      deny: this.options.rules.denyBash,
    });

    if (verdict.kind === 'deny' && this.options.mode !== 'yolo') {
      throw new PermissionDeniedError(`Command ${verdict.reason}. Run it yourself if you intend it.`);
    }
    if (this.options.mode === 'yolo') return;
    if (this.options.mode === 'readonly' && verdict.kind !== 'safe') {
      throw new PermissionDeniedError(
        `Cannot run \`${command}\`: running in readonly mode, only read-only commands are permitted.`,
      );
    }
    if (verdict.kind === 'safe') return;

    await this.request({
      id: randomUUID(),
      toolName: 'bash',
      title: t('perm.runTitle', { command }),
      detail: cwdLabel ? t('perm.inDir', { dir: cwdLabel }) : undefined,
      suggestedRule: verdict.suggestedRule,
      risk: 'execute',
    });
  }

  /** MCP 工具是不透明的,所以在非 yolo 模式下总是需要确认。 */
  async checkMcpTool(toolName: string, input: unknown): Promise<void> {
    if (this.options.mode === 'yolo') return;
    if (this.options.mode === 'readonly') {
      throw new PermissionDeniedError(
        `Cannot call MCP tool ${toolName}: running in readonly mode.`,
      );
    }
    const rule = `Mcp(${toolName})`;
    if (this.sessionAllowBash.includes(rule)) return;

    await this.request({
      id: randomUUID(),
      toolName,
      title: t('perm.mcpTitle', { name: toolName }),
      detail: safeJson(input),
      suggestedRule: rule,
      risk: 'execute',
    });
  }

  private async request(req: PermissionRequest): Promise<void> {
    this.options.bus.emit({ type: 'permission-request', request: req });
    const decision = await this.options.ask(req);
    this.options.bus.emit({ type: 'permission-resolved', id: req.id, decision });

    if (decision.type === 'deny') {
      throw new PermissionDeniedError(
        decision.reason
          ? `User denied this action: ${decision.reason}`
          : 'User denied this action. Do not retry it; ask what to do instead.',
      );
    }

    if (decision.type === 'allow-always' || decision.type === 'allow-persist') {
      this.remember(req.risk, decision.rule);
      if (decision.type === 'allow-persist') {
        await this.persist(req.risk, decision.rule).catch((err: Error) => {
          this.options.bus.emit({
            type: 'notice',
            level: 'warn',
            message: t('notice.ruleSaveFailed', { message: err.message }),
          });
        });
      }
    }
  }

  private remember(risk: PermissionRequest['risk'], rule: string): void {
    if (risk === 'write') {
      if (!this.sessionAllowWrite.includes(rule)) this.sessionAllowWrite.push(rule);
    } else if (!this.sessionAllowBash.includes(rule)) {
      this.sessionAllowBash.push(rule);
    }
  }

  /** 把规则追加到 <workspace>/.kdg/config.json,文件不存在则创建。 */
  private async persist(risk: PermissionRequest['risk'], rule: string): Promise<void> {
    const file = projectConfigPath(this.options.root);
    await fs.mkdir(projectDir(this.options.root), { recursive: true });

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const permissions = (existing.permissions ?? {}) as Record<string, string[]>;
    const key = risk === 'write' ? 'allowWrite' : 'allowBash';
    const list = Array.isArray(permissions[key]) ? permissions[key] : [];
    if (!list.includes(rule)) list.push(rule);
    permissions[key] = list;
    existing.permissions = permissions;

    await fs.writeFile(file, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');

    // 同步更新内存中的规则,避免同一个文件被提示两次。
    if (risk === 'write') this.options.rules.allowWrite.push(rule);
    else this.options.rules.allowBash.push(ruleToPrefix(rule));
  }
}

/** `src/foo/bar.ts` → `src/foo/**`,批准一个文件即覆盖其所在目录。 */
function suggestWriteRule(relativePath: string): string {
  const dir = path.posix.dirname(relativePath);
  return dir === '.' ? relativePath : `${dir}/**`;
}

function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value, null, 2);
    return text && text.length > 2000 ? `${text.slice(0, 2000)}\n${t('ui.truncated')}` : text;
  } catch {
    return undefined;
  }
}
