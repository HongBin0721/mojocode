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
 * Decides whether a tool call may proceed.
 *
 * AI SDK 7 ships a `toolApproval` mechanism, but it suspends the stream and
 * expects the caller to resume with approval messages — built for a
 * client/server round-trip. In a CLI we own the loop, so gating inside
 * `execute()` is both simpler and keeps the stream alive while the user decides.
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
   * Replaces the approval callback. The TUI installs its own once mounted; the
   * bootstrap-time asker is the headless fallback used before that (and by
   * `-p` mode for the whole run).
   */
  setAsker(ask: PermissionAsker): void {
    this.options.ask = ask;
  }

  /**
   * Called before a mutating tool does any work at all.
   *
   * Separate from `checkWrite` because tools take shortcuts — `write` returns
   * early when the content is unchanged — and readonly mode must hold even on
   * those paths, or the guarantee depends on which branch happens to run.
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
      title: `Write ${relativePath}`,
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
      title: `Run \`${command}\``,
      detail: cwdLabel ? `in ${cwdLabel}` : undefined,
      suggestedRule: verdict.suggestedRule,
      risk: 'execute',
    });
  }

  /** MCP tools are opaque, so they always prompt outside yolo mode. */
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
      title: `Call MCP tool ${toolName}`,
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

  /** Appends the rule to <workspace>/.kdg/config.json, creating it if needed. */
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

    // Keep the in-memory rules in sync so the same file doesn't prompt twice.
    if (risk === 'write') this.options.rules.allowWrite.push(rule);
    else this.options.rules.allowBash.push(ruleToPrefix(rule));
  }
}

/** `src/foo/bar.ts` → `src/foo/**` so approving one file covers its directory. */
function suggestWriteRule(relativePath: string): string {
  const dir = path.posix.dirname(relativePath);
  return dir === '.' ? relativePath : `${dir}/**`;
}

function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value, null, 2);
    return text && text.length > 2000 ? `${text.slice(0, 2000)}\n… (truncated)` : text;
  } catch {
    return undefined;
  }
}
