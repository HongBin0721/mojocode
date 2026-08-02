import { z } from 'zod';

/**
 * 权限模型是两根正交的轴,对齐 Codex:
 *
 * - **sandbox**(能做什么):`read-only` 只读;`workspace-write` 工作区内文件
 *   编辑自由;`danger-full-access` 连硬拒命令名单也绕过(对应旧 yolo)。
 * - **approval**(什么时候问):`untrusted` 除安全白名单外全部确认;
 *   `on-request` 沙箱内自由、沙箱外弹确认(升级);`never` 从不弹框,
 *   沙箱外的操作直接以错误返回给模型。
 *
 * 与 Codex 的差别必须说清:Codex 的 sandbox 是 OS 内核强制(Seatbelt/Landlock),
 * 命令真的跑在沙箱里,所以 workspace-write 下任意命令可以放行——内核保证它
 * 出不了工作区。mojocode 的约束在权限门这一层,无法把一条 bash 命令圈在
 * 工作区里,所以 workspace-write 下非白名单命令仍视为"沙箱外"(要确认或被拒),
 * Codex 的 `on-failure`(沙箱内先跑、失败再升级)也因此不存在。
 * 路径硬约束(realpath 圈定工作区,.git、.env 系列、密钥永远禁止)与两轴无关,
 * 在任何组合下都生效——这是 mojocode 自己的不变量,danger-full-access 也不豁免。
 *
 * plan(计划模式)不在轴上:它是协作方式,激活时压过两轴(等同只读),
 * 批准方案后还原。见 PermissionGate 与 bootstrap。
 */
export const sandboxModeSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);
export type SandboxMode = z.infer<typeof sandboxModeSchema>;

export const approvalPolicySchema = z.enum(['untrusted', 'on-request', 'never']);
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

/** 一对两轴取值。gate、bootstrap、UI 之间传递的最小单位。 */
export interface Permissions {
  sandbox: SandboxMode;
  approval: ApprovalPolicy;
}

/**
 * `/approvals` 的预设,即两轴的常用组合(Codex 的 Read Only / Auto / Full Access,
 * 外加 mojocode 一直以来的默认档 ask)。数组顺序即选择器展示顺序,按放宽递增。
 */
export const APPROVAL_PRESETS = [
  // 只读调研,但写入和命令可以逐次升级确认——区别于 plan(完全不能写)。
  { id: 'read-only', sandbox: 'read-only', approval: 'on-request' },
  // 默认:写文件、跑非白名单命令都确认。等价旧 ask。
  { id: 'ask', sandbox: 'workspace-write', approval: 'untrusted' },
  // 工作区内编辑自由,命令仍确认。等价旧 acceptEdits;Codex 的 Auto。
  { id: 'auto', sandbox: 'workspace-write', approval: 'on-request' },
  // 全自动,连硬拒名单也绕过。等价旧 yolo;只在本会话有效,永不落盘。
  { id: 'full-access', sandbox: 'danger-full-access', approval: 'never' },
] as const satisfies readonly ({ id: string } & Permissions)[];
export type ApprovalPresetId = (typeof APPROVAL_PRESETS)[number]['id'];

export function presetById(id: ApprovalPresetId): Permissions {
  const preset = APPROVAL_PRESETS.find((p) => p.id === id)!;
  return { sandbox: preset.sandbox, approval: preset.approval };
}

/** 当前组合对应的预设 id;自由组合(如 read-only+never)返回 undefined。 */
export function presetFor(p: Permissions): ApprovalPresetId | undefined {
  return APPROVAL_PRESETS.find((x) => x.sandbox === p.sandbox && x.approval === p.approval)?.id;
}

/** 状态栏/头部的显示标签:预设名,或自由组合的 `sandbox·approval`。 */
export function permissionsLabel(p: Permissions): string {
  return presetFor(p) ?? `${p.sandbox}·${p.approval}`;
}

/**
 * 这套组合下写入是否*有可能*发生(直接放行或经确认升级)。
 * `/init` 据此提前拦下注定写不出文件的一轮;plan 激活时恒为否。
 */
export function canEverWrite(p: Permissions, planActive: boolean): boolean {
  if (planActive) return false;
  return !(p.sandbox === 'read-only' && p.approval === 'never');
}

/**
 * full-access(danger-full-access)只在本会话有效,永不写进配置或会话记录:
 * 它绕过硬拒名单,是"就这一次"的临时逃生口——否则开一次,之后每次
 * `mojocode -c` 都会在命令行没有任何标志的情况下静默全自动放行。
 */
export function isEphemeralPermissions(p: Permissions): boolean {
  return p.sandbox === 'danger-full-access';
}

/**
 * shift+tab 的循环:ask → auto → plan → ask。
 *
 * 刻意不含 full-access——它绕过硬拒名单,绝不能离一个快捷键只有一步之遥。
 * 当前组合不在循环里(read-only、full-access、自由组合)时落到 plan:它写不了
 * 任何东西,所以无论从哪起步,误触都只可能收紧权限,不可能放宽。
 */
export function nextCycleStep(
  p: Permissions,
  planActive: boolean,
): { plan: true } | { preset: 'ask' | 'auto' } {
  if (planActive) return { preset: 'ask' };
  const preset = presetFor(p);
  if (preset === 'ask') return { preset: 'auto' };
  if (preset === 'auto') return { plan: true };
  return { plan: true };
}

/**
 * 从 `current` 进入计划模式时,方案获批后应当还原的组合。
 *
 * 只有一种情况不忠实还原:read-only+never——那套组合下批准完仍旧一个字都
 * 改不了,"批准"就没有意义了,所以提升到 ask(逐次确认)。read-only+on-request
 * 忠实还原:实现阶段的每次写入走升级确认,批准本身仍然有意义。
 */
export function planReturnFor(current: Permissions): { perms: Permissions; promoted: boolean } {
  if (!canEverWrite(current, false)) return { perms: presetById('ask'), promoted: true };
  return { perms: { ...current }, promoted: false };
}

/**
 * 旧的单轴 permissionMode 到两轴的一次性映射,用于读取旧配置与旧会话文件。
 * `plan` 与未知值返回 undefined(plan 从来不落盘,落了也不该复活)。
 */
export function fromLegacyMode(mode: string): Permissions | undefined {
  switch (mode) {
    case 'readonly':
      return { sandbox: 'read-only', approval: 'never' };
    case 'ask':
      return { sandbox: 'workspace-write', approval: 'untrusted' };
    case 'acceptEdits':
      return { sandbox: 'workspace-write', approval: 'on-request' };
    case 'yolo':
      return { sandbox: 'danger-full-access', approval: 'never' };
    default:
      return undefined;
  }
}

/** 状态栏可选的信息段。状态文字本身始终显示,不在此列。枚举顺序即展示顺序,mode 固定排第一。 */
export const statusSegmentSchema = z.enum(['mode', 'model', 'cwd', 'think', 'context', 'total', 'todos']);
export type StatusSegment = z.infer<typeof statusSegmentSchema>;
export const STATUS_SEGMENTS = statusSegmentSchema.options;

/** 模型思考强度档位。auto = 不传任何参数、交给服务端默认;off = 显式关闭思考。 */
export const reasoningEffortSchema = z.enum(['auto', 'off', 'low', 'medium', 'high', 'max']);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export const REASONING_EFFORTS = reasoningEffortSchema.options;

/** 用户声明的 provider 条目。内置 id 只需填写要覆盖的字段。 */
export const providerConfigSchema = z.object({
  baseURL: z.url().optional(),
  apiKey: z.string().optional(),
  /** 读取 API key 的环境变量名,覆盖预设中的列表。 */
  apiKeyEnv: z.string().optional(),
  model: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  contextWindow: z.number().int().positive().optional(),
  parallelToolCalls: z.boolean().optional(),
  /** 该 provider 专属的思考强度,覆盖顶层 `reasoningEffort`。 */
  reasoningEffort: reasoningEffortSchema.optional(),
  label: z.string().optional(),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const mcpServerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    enabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('http'),
    url: z.url(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().default(true),
  }),
]);
export type McpServerConfig = z.infer<typeof mcpServerSchema>;

export const permissionRulesSchema = z.object({
  /** 无需确认即可执行的 bash 命令前缀,例如 "git status"、"npm test"。 */
  allowBash: z.array(z.string()).default([]),
  /** 在内置拒绝列表之外,总是被拒绝的 bash 命令前缀。 */
  denyBash: z.array(z.string()).default([]),
  /** 无需确认即可写入的 glob(相对于工作区根目录)。 */
  allowWrite: z.array(z.string()).default([]),
  /** 永远不允许读或写的 glob。 */
  denyPath: z.array(z.string()).default([]),
});
export type PermissionRules = z.infer<typeof permissionRulesSchema>;

export const configSchema = z.object({
  /** 当前激活的 provider id——内置预设或 `providers` 中的键。 */
  provider: z.string().default('deepseek'),
  /** 覆盖当前 provider 的默认模型。 */
  model: z.string().optional(),
  providers: z.record(z.string(), providerConfigSchema).default({}),
  /** 两轴权限,见文件头注释。默认组合即 `ask` 预设。 */
  sandbox: sandboxModeSchema.default('workspace-write'),
  approval: approvalPolicySchema.default('untrusted'),
  /** 以计划模式启动(--plan)。运行态标志,永不落盘,写在配置里也只影响启动。 */
  plan: z.boolean().default(false),
  permissions: permissionRulesSchema.default({
    allowBash: [],
    denyBash: [],
    allowWrite: [],
    denyPath: [],
  }),
  mcpServers: z.record(z.string(), mcpServerSchema).default({}),
  /** 每轮用户输入内 agent 循环步数的硬上限——防失控的兜底措施。 */
  maxSteps: z.number().int().positive().default(50),
  temperature: z.number().min(0).max(2).optional(),
  /** 思考强度的全局默认值,可被 providers.<id>.reasoningEffort 覆盖,用 /think 调整。 */
  reasoningEffort: reasoningEffortSchema.default('auto'),
  /** 输入 token 超过上下文窗口的这一比例时压缩历史。 */
  compactThreshold: z.number().min(0.1).max(0.95).default(0.8),
  /** 强制指定上下文窗口,覆盖 provider 预设。测试压缩逻辑时很有用。 */
  maxContext: z.number().int().positive().optional(),
  /** 追加到系统提示词末尾的额外指令。 */
  systemPromptAppend: z.string().optional(),
  /** UI 语言。`auto` 跟随 MOJOCODE_LANG / LANG。 */
  language: z.enum(['auto', 'en', 'zh-CN']).default('auto'),
  /** 状态栏显示的信息段,可用 /statusbar 调整。 */
  statusBar: z.array(statusSegmentSchema).default([...STATUS_SEGMENTS]),
  /** 会话文件保留天数,启动时清理超期未活动的会话。 */
  cleanupPeriodDays: z.number().int().positive().default(30),
});

export type Config = z.infer<typeof configSchema>;

/** 与 `Config` 形状相同但所有字段可选——即配置文件里可以写的内容。 */
export const partialConfigSchema = configSchema.partial();
export type PartialConfig = z.input<typeof partialConfigSchema>;
