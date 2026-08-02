import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  PermissionAsker,
  PermissionDecision,
  PermissionRequest,
  EventBus,
} from '../core/events.js';
import type { ApprovalPolicy, Permissions, PermissionRules, SandboxMode } from '../config/schema.js';
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
  permissions: Permissions;
  /** 计划模式激活时压过两轴:等同只读且不可升级,出口是 exit_plan。 */
  plan: boolean;
  rules: PermissionRules;
  ask: PermissionAsker;
  bus: EventBus;
  /** 会话级规则新增时的回调——bootstrap 借此把规则持久化进会话文件。 */
  onRulesChanged?: () => void;
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
  /** 授权询问的排队链,保证一次只有一个确认框在等用户。见 askSerialized。 */
  private askChain: Promise<void> = Promise.resolve();
  /** 本轮是否已中断。中断后还排在队里的询问一律自动拒绝,见 cancelPending。 */
  private pendingCancelled = false;

  constructor(private readonly options: GateOptions) {}

  get sandbox(): SandboxMode {
    return this.options.permissions.sandbox;
  }

  get approval(): ApprovalPolicy {
    return this.options.permissions.approval;
  }

  get planMode(): boolean {
    return this.options.plan;
  }

  setPermissions(permissions: Permissions): void {
    this.options.permissions = { ...permissions };
  }

  setPlanMode(active: boolean): void {
    this.options.plan = active;
  }

  /**
   * 替换批准回调。TUI 挂载后会安装自己的回调;在那之前用的是启动时的
   * headless 兜底回调(`-p` 模式则全程使用它)。
   */
  setAsker(ask: PermissionAsker): void {
    this.options.ask = ask;
  }

  /** 轮被中断:丢弃排队中的授权询问(它们会以拒绝收场),不再打扰用户。 */
  cancelPending(): void {
    this.pendingCancelled = true;
  }

  /** 新一轮开始,重新接受排队询问。 */
  resumePending(): void {
    this.pendingCancelled = false;
  }

  /**
   * "完全写不了"的两种情形:plan 激活,或 read-only+never(沙箱只读且升级
   * 通道也被 never 关死)。read-only+on-request **不算**——写入可以逐次升级
   * 确认,所以不在这里拦,由 checkWrite/checkBash 弹确认。
   */
  private hardStopReason(action: string): string | undefined {
    if (this.options.plan) {
      return (
        `Cannot ${action}: you are in plan mode. Keep researching with the read-only tools, ` +
        'then call the exit_plan tool to submit your plan for approval. Do not attempt edits before it is approved.'
      );
    }
    const { sandbox, approval } = this.options.permissions;
    if (sandbox === 'read-only' && approval === 'never') {
      return (
        `Cannot ${action}: the sandbox is read-only and the approval policy is never, ` +
        'so nothing can be escalated. Ask the user to relaunch with a writable sandbox.'
      );
    }
    return undefined;
  }

  /**
   * 在会修改状态的工具做任何工作之前调用。
   *
   * 与 `checkWrite` 分开,是因为工具会走捷径——`write` 在内容未变化时会
   * 提前返回——而硬停组合(plan、read-only+never)在这些路径上也必须成立,
   * 否则这条保证就取决于恰好执行了哪个分支。可升级的组合在这里放行,
   * 确认发生在 checkWrite。
   */
  assertCanMutate(what: string): void {
    const reason = this.hardStopReason(`modify ${what}`);
    if (reason) throw new PermissionDeniedError(reason);
  }

  async checkWrite(relativePath: string, detail?: string): Promise<void> {
    this.assertCanMutate(relativePath);
    const { sandbox, approval } = this.options.permissions;
    if (sandbox === 'danger-full-access') return;

    if (sandbox === 'read-only') {
      // 沙箱外的升级确认。刻意不带 suggestedRule 也不查允许名单:read-only
      // 沙箱下"始终允许写 src/**"是自相矛盾的——每一次写都该单独过目。
      await this.request({
        id: randomUUID(),
        toolName: 'write',
        title: t('perm.writeTitle', { path: relativePath }),
        detail,
        risk: 'write',
      });
      return;
    }

    // workspace-write:on-request / never 下工作区写入在沙箱内,自由放行;
    // untrusted 下写入也要确认(等价旧 ask)。
    if (approval !== 'untrusted') return;

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
    const { sandbox, approval } = this.options.permissions;
    const verdict = judgeCommand(command, {
      allow: [...this.options.rules.allowBash, ...this.sessionAllowBash],
      deny: this.options.rules.denyBash,
      // 只读环境下,跑测试/npm scripts 会执行仓库自带的任意代码,allow 规则
      // 也是在可写语境下授的权——都不能自动放行,见 JudgeOptions.readOnly。
      readOnly: this.options.plan || sandbox === 'read-only',
    });

    // 硬拒名单永不进确认框,只有 danger-full-access 沙箱绕过它(对应旧 yolo)。
    // plan 激活时不享受这条豁免:计划模式下连普通写入都不行,遑论灾难命令。
    if (verdict.kind === 'deny' && (this.options.plan || sandbox !== 'danger-full-access')) {
      throw new PermissionDeniedError(`Command ${verdict.reason}. Run it yourself if you intend it.`);
    }
    if (!this.options.plan && sandbox === 'danger-full-access') return;
    if (verdict.kind === 'safe') return;

    // 非白名单命令一律视为"沙箱外":没有 OS 沙箱能把命令圈在工作区里,
    // 所以 workspace-write 也不放行——这是与 Codex 的刻意差异,见 schema.ts。
    const reason = this.hardStopReason(`run \`${command}\``);
    if (reason) throw new PermissionDeniedError(`${reason} Only read-only commands run freely.`);

    if (approval === 'never') {
      throw new PermissionDeniedError(
        `Cannot run \`${command}\`: it is not on the safe list and the approval policy is never, ` +
          'so it cannot be escalated. Use safe read-only commands, or ask the user to change the policy.',
      );
    }

    // read-only 的升级确认不带 suggestedRule:只读沙箱下不该记住放行规则。
    await this.request({
      id: randomUUID(),
      toolName: 'bash',
      title: t('perm.runTitle', { command }),
      detail: cwdLabel ? t('perm.inDir', { dir: cwdLabel }) : undefined,
      suggestedRule: sandbox === 'read-only' ? undefined : verdict.suggestedRule,
      risk: 'execute',
    });
  }

  /** MCP 工具是不透明的,所以除 danger-full-access 外总要确认(或被 never 拒绝)。 */
  async checkMcpTool(toolName: string, input: unknown): Promise<void> {
    const { sandbox, approval } = this.options.permissions;
    if (!this.options.plan && sandbox === 'danger-full-access') return;

    const reason = this.hardStopReason(`call MCP tool ${toolName}`);
    if (reason) throw new PermissionDeniedError(reason);

    if (approval === 'never') {
      throw new PermissionDeniedError(
        `Cannot call MCP tool ${toolName}: the approval policy is never and MCP tools are opaque, ` +
          'so they cannot be escalated.',
      );
    }

    const rule = `Mcp(${toolName})`;
    if (sandbox !== 'read-only' && this.sessionAllowBash.includes(rule)) return;

    await this.request({
      id: randomUUID(),
      toolName,
      title: t('perm.mcpTitle', { name: toolName }),
      detail: safeJson(input),
      suggestedRule: sandbox === 'read-only' ? undefined : rule,
      risk: 'execute',
    });
  }

  /**
   * 呈交实现方案等待用户批准(计划模式的出口)。
   *
   * 复用 askSerialized 拿到排队与"轮被中断即自动拒绝"这两件事,但**返回**决定
   * 而不是抛错:用户选"继续完善方案"是正常的往复,不是失败——走 request() 的话
   * 会抛 PermissionDeniedError,时间线上就画成一条红色的工具报错。
   *
   * 门禁只负责问,不碰会话状态:切模式由 exit_plan 工具调 ToolContext 注入的
   * 回调完成(门禁够不到系统提示词与会话持久化)。
   */
  async requestPlanApproval(plan: string): Promise<{ approved: boolean; reason?: string }> {
    const req: PermissionRequest = {
      id: randomUUID(),
      kind: 'plan',
      toolName: 'exit_plan',
      title: t('perm.planTitle'),
      detail: plan,
      risk: 'write',
    };
    const decision = await this.askSerialized(req);
    this.options.bus.emit({ type: 'permission-resolved', id: req.id, decision });
    // 只认 allow;allow-always/allow-persist 对方案没有意义(方案不产生规则),
    // 真出现了也按"未批准"处理,绝不放宽。
    if (decision.type === 'allow') return { approved: true };
    return { approved: false, reason: decision.type === 'deny' ? decision.reason : undefined };
  }

  private async request(req: PermissionRequest): Promise<void> {
    const decision = await this.askSerialized(req);
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

  /**
   * 让授权询问排队,一次只呈现一个。
   *
   * 并行工具调用会同时申请授权,而界面一次只放得下一个确认框:后到的请求
   * 会顶掉前一个,先到的那个 promise 就永远悬着——对应的工具卡死,整轮要
   * 等用户按 esc 才结束;确认框里的光标还可能停在新请求根本不存在的选项
   * 上,回车即崩溃。`permission-request` 事件同样要等轮到自己时才发出,
   * 否则 UI 仍会被后来的请求提前覆盖。
   */
  private askSerialized(req: PermissionRequest): Promise<PermissionDecision> {
    const decision = this.askChain.then((): PermissionDecision | Promise<PermissionDecision> => {
      // 轮已经中断,队列里剩下的请求不该再弹给用户:那一轮已经死了,用户
      // 却要挨个消确认框才能拿回输入框;更要紧的是此时批准仍会真的执行——
      // write/edit 不接 abortSignal,点了"允许"就直接写盘。
      if (this.pendingCancelled) {
        return { type: 'deny', reason: 'the turn was interrupted before it could be approved' };
      }
      this.options.bus.emit({ type: 'permission-request', request: req });
      return this.options.ask(req);
    });
    // 链条只用来排队,不传播失败——一次拒绝或异常不该毒化后续所有请求。
    this.askChain = decision.then(
      () => undefined,
      () => undefined,
    );
    return decision;
  }

  private remember(risk: PermissionRequest['risk'], rule: string): void {
    if (risk === 'write') {
      if (!this.sessionAllowWrite.includes(rule)) this.sessionAllowWrite.push(rule);
    } else if (!this.sessionAllowBash.includes(rule)) {
      this.sessionAllowBash.push(rule);
    }
    this.options.onRulesChanged?.();
  }

  /** 导出会话级规则(副本),供写入会话文件后跨恢复还原。 */
  exportSessionRules(): { allowBash: string[]; allowWrite: string[] } {
    return { allowBash: [...this.sessionAllowBash], allowWrite: [...this.sessionAllowWrite] };
  }

  /**
   * 恢复会话时用该会话记住的规则*替换*当前会话规则,不触发 onRulesChanged。
   *
   * 必须是替换而非追加:`/resume` 切到别的会话时,上一段对话里"本会话始终
   * 允许"的授权不能跟着漂过去——否则下一次 saveState 还会把两者的并集写进
   * 新会话文件,泄漏就永久留存了。
   */
  setSessionRules(rules: { allowBash: string[]; allowWrite: string[] }): void {
    this.sessionAllowBash.length = 0;
    this.sessionAllowWrite.length = 0;
    for (const rule of rules.allowBash) {
      if (!this.sessionAllowBash.includes(rule)) this.sessionAllowBash.push(rule);
    }
    for (const rule of rules.allowWrite) {
      if (!this.sessionAllowWrite.includes(rule)) this.sessionAllowWrite.push(rule);
    }
  }

  /** 把规则追加到 <workspace>/.mojocode/config.json,文件不存在则创建。 */
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
