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
import { judgeUrl, resolvesToInternal, suggestNetRule, WEB_SEARCH_RULE } from './net-rules.js';
import { matchGlob } from './sandbox.js';
import { t } from '../i18n/index.js';

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

/**
 * 调用方身份。目前只区分"是不是子 agent",且**只影响硬停时的措辞**——
 * 权限判定本身对主、子 agent 完全一致(同一个门、同一套会话规则、同一个
 * 确认框队列)。子 agent 没有 exit_plan 也问不了用户,照抄主 agent 的提示
 * 会把它引向不存在的工具。
 */
export interface GateCallerOptions {
  subagent?: boolean;
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
  private readonly sessionAllowNet: string[] = [];
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
  private hardStopReason(action: string, subagent = false): string | undefined {
    if (this.options.plan) {
      // 子 agent 没有 exit_plan(也不该有:方案审批是主 agent 与用户之间的事),
      // 照抄主 agent 那句会让它去调一个不存在的工具,拿到 NoSuchTool 再重试,
      // 一路空转到步数上限。同理它也没法"问用户"。
      return subagent
        ? `Cannot ${action}: the session is in plan mode, so nothing can be modified. ` +
            'Research with the read-only tools and report what you found. ' +
            'Do not call exit_plan — you do not have it; the main agent submits the plan.'
        : `Cannot ${action}: you are in plan mode. Keep researching with the read-only tools, ` +
            'then call the exit_plan tool to submit your plan for approval. Do not attempt edits before it is approved.';
    }
    const { sandbox, approval } = this.options.permissions;
    if (sandbox === 'read-only' && approval === 'never') {
      return (
        `Cannot ${action}: the sandbox is read-only and the approval policy is never, ` +
        'so nothing can be escalated. ' +
        (subagent
          ? 'You cannot ask the user. Report what you found with the read-only tools instead.'
          : 'Ask the user to relaunch with a writable sandbox.')
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
  assertCanMutate(what: string, opts?: GateCallerOptions): void {
    const reason = this.hardStopReason(`modify ${what}`, opts?.subagent);
    if (reason) throw new PermissionDeniedError(reason);
  }

  async checkWrite(relativePath: string, detail?: string, opts?: GateCallerOptions): Promise<void> {
    this.assertCanMutate(relativePath, opts);
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

  async checkBash(command: string, cwdLabel: string, opts?: GateCallerOptions): Promise<void> {
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
    const reason = this.hardStopReason(`run \`${command}\``, opts?.subagent);
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
  async checkMcpTool(toolName: string, input: unknown, opts?: GateCallerOptions): Promise<void> {
    const { sandbox, approval } = this.options.permissions;
    if (!this.options.plan && sandbox === 'danger-full-access') return;

    const reason = this.hardStopReason(`call MCP tool ${toolName}`, opts?.subagent);
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
   * 联网工具(web_search / web_fetch)的门禁。
   *
   * 与 checkMcpTool 的两处刻意差异:
   * 1. **私网硬拒先于一切**,danger-full-access 也不豁免——与 sandbox.ts 的
   *    路径硬约束同一哲学,模型不该有任何路径去探测内网/云元数据。
   * 2. **规则放行排在 never 判定之前**——让 approval=never / headless 档可以
   *    靠配置好的 allowNet 无人值守联网,这是 CI 场景的正门;MCP 工具因为
   *    完全不透明才被 never 一律拒绝,联网规则有域名粒度,不适用同一条理由。
   *
   * 也刻意不调 hardStopReason:plan 模式允许联网调研是产品决策,联网不参与
   * read-only 的"写不了"语义。
   */
  async checkNet(
    req: { tool: 'web_search'; query: string } | { tool: 'web_fetch'; url: string },
  ): Promise<void> {
    const { sandbox, approval } = this.options.permissions;
    const allowRules = [...this.options.rules.allowNet, ...this.sessionAllowNet];

    let title: string;
    let detail: string;
    let suggestedRule: string;
    if (req.tool === 'web_fetch') {
      const verdict = judgeUrl(req.url, allowRules);
      if (verdict.kind === 'invalid' || verdict.kind === 'blocked') {
        throw new PermissionDeniedError(verdict.reason);
      }
      // 字面量过关还不够:公网形状的名字可能解析到内网(nip.io 之类)。
      // 这一步同样先于 danger-full-access 与 allow 规则——私网是硬线。
      const internalAddr = await resolvesToInternal(verdict.host);
      if (internalAddr) {
        throw new PermissionDeniedError(
          `Refused: ${verdict.host} resolves to ${internalAddr}, an internal address. ` +
            'Fetching internal network targets is never allowed. To reach a local server, ' +
            'use its address directly (e.g. http://localhost:PORT/).',
        );
      }
      if (!this.options.plan && sandbox === 'danger-full-access') return;
      if (verdict.kind === 'allowed') return;
      title = t('perm.webFetchTitle', { host: verdict.host });
      detail = req.url;
      suggestedRule = verdict.suggestedRule;
    } else {
      if (!this.options.plan && sandbox === 'danger-full-access') return;
      if (allowRules.includes(WEB_SEARCH_RULE)) return;
      title = t('perm.webSearchTitle', { query: req.query });
      detail = req.query;
      suggestedRule = suggestNetRule({ tool: 'web_search' });
    }

    if (approval === 'never') {
      throw new PermissionDeniedError(
        `Cannot access the network: the approval policy is never and this target is not covered ` +
          `by an allowNet rule. Ask the user to add "${suggestedRule}" to permissions.allowNet.`,
      );
    }

    // suggestedRule 不做 read-only/plan 抑制(与 bash/MCP 不同):bash 在只读
    // 沙箱抑制记忆,是因为那些授权属于"可写语境"的信任;而"信任这个域名"
    // 与沙箱档位无关,plan 里批过的域名到实现阶段照样应该免打扰。
    await this.request({
      id: randomUUID(),
      toolName: req.tool,
      title,
      detail,
      suggestedRule,
      risk: 'network',
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

  /**
   * 技能 allowed-tools 的一次性会话预授权(整批问一次,与逐条确认的
   * request() 相对)。拒绝返回 false 而不抛错——技能正文照常加载,只是
   * 后续工具调用回到逐条确认的常态,与"用户打回方案"同一态度:这是正常
   * 选择,不是失败。
   *
   * 批准后规则进**会话**桶(remember),不落盘:frontmatter 是随仓库来的
   * 内容,让它一句话就把规则写进项目配置等于永久后门;要留存该走确认框
   * 的 allow-persist,那是用户逐条看过的。danger-full-access 短路为 true:
   * 反正全放行,弹框是纯打扰。
   */
  async confirmSessionRules(origin: string, rules: string[]): Promise<boolean> {
    if (rules.length === 0) return true;
    if (!this.options.plan && this.sandbox === 'danger-full-access') return true;

    const req: PermissionRequest = {
      id: randomUUID(),
      toolName: 'skill',
      title: t('perm.skillRules', { name: origin }),
      detail: rules.join('\n'),
      // execute 桶只是缺省归属;真正分桶在下面按规则前缀逐条判。
      risk: 'execute',
    };
    const decision = await this.askSerialized(req);
    this.options.bus.emit({ type: 'permission-resolved', id: req.id, decision });
    if (decision.type === 'deny') return false;

    for (const rule of rules) {
      this.remember(riskOfRule(rule), rule);
    }
    return true;
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
    } else if (risk === 'network') {
      if (!this.sessionAllowNet.includes(rule)) this.sessionAllowNet.push(rule);
    } else if (!this.sessionAllowBash.includes(rule)) {
      this.sessionAllowBash.push(rule);
    }
    this.options.onRulesChanged?.();
  }

  /** 导出会话级规则(副本),供写入会话文件后跨恢复还原。 */
  exportSessionRules(): { allowBash: string[]; allowWrite: string[]; allowNet: string[] } {
    return {
      allowBash: [...this.sessionAllowBash],
      allowWrite: [...this.sessionAllowWrite],
      allowNet: [...this.sessionAllowNet],
    };
  }

  /**
   * 恢复会话时用该会话记住的规则*替换*当前会话规则,不触发 onRulesChanged。
   *
   * 必须是替换而非追加:`/resume` 切到别的会话时,上一段对话里"本会话始终
   * 允许"的授权不能跟着漂过去——否则下一次 saveState 还会把两者的并集写进
   * 新会话文件,泄漏就永久留存了。
   */
  setSessionRules(rules: { allowBash: string[]; allowWrite: string[]; allowNet?: string[] }): void {
    this.sessionAllowBash.length = 0;
    this.sessionAllowWrite.length = 0;
    this.sessionAllowNet.length = 0;
    for (const rule of rules.allowBash) {
      if (!this.sessionAllowBash.includes(rule)) this.sessionAllowBash.push(rule);
    }
    for (const rule of rules.allowWrite) {
      if (!this.sessionAllowWrite.includes(rule)) this.sessionAllowWrite.push(rule);
    }
    for (const rule of rules.allowNet ?? []) {
      if (!this.sessionAllowNet.includes(rule)) this.sessionAllowNet.push(rule);
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
    const key = risk === 'write' ? 'allowWrite' : risk === 'network' ? 'allowNet' : 'allowBash';
    const list = Array.isArray(permissions[key]) ? permissions[key] : [];
    if (!list.includes(rule)) list.push(rule);
    permissions[key] = list;
    existing.permissions = permissions;

    await fs.writeFile(file, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');

    // 同步更新内存中的规则,避免同一个目标被提示两次。allowNet 存整串规则
    // (WebSearch / WebFetch(domain:x)),不像 bash 那样折算成前缀。
    if (risk === 'write') this.options.rules.allowWrite.push(rule);
    else if (risk === 'network') this.options.rules.allowNet.push(rule);
    else this.options.rules.allowBash.push(ruleToPrefix(rule));
  }
}

/**
 * allowed-tools 规则 → 会话桶。规则串的形状即桶的选择依据:
 * `Bash(x:*)` / `Mcp(name)` 进 bash 桶(remember 的 execute 分支),
 * `WebSearch` / `WebFetch(domain:x)` 进 net 桶,其余当写入 glob。
 */
function riskOfRule(rule: string): PermissionRequest['risk'] {
  if (rule.startsWith('Bash(') || rule.startsWith('Mcp(')) return 'execute';
  if (rule === 'WebSearch' || rule.startsWith('WebFetch(')) return 'network';
  return 'write';
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
