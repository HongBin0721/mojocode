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
  // 全自动,连硬拒名单也绕过。等价旧 yolo;选中会留存,但每次都在时间线上留警告。
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
 * full-access(danger-full-access)绕过硬拒名单,是全部档位里唯一能让模型
 * 在工作区外动手、跑 `rm -rf`/`sudo` 这类命令的一档。
 *
 * 它和其余档位一样会被留存(用户显式选的档位就该活到下一次启动),但选中它
 * 必须在时间线上留一条警告:底栏两秒的回显翻不出来,事后看记录得能认出这一
 * 段是在无沙箱下跑的。
 */
export function isDangerousPermissions(p: Permissions): boolean {
  return p.sandbox === 'danger-full-access';
}

/**
 * shift+tab 的循环:read-only → ask → auto → full-access → plan → read-only。
 *
 * 四个预设按 APPROVAL_PRESETS 的顺序(放宽递增)走一遍,再经 plan 回到最紧的
 * 一档。full-access 也在循环里——它绕过硬拒名单,所以落到它时 UI 要在时间线上
 * 留一条警告(见 App 的 applyMode)。
 * 当前组合不在预设里(自由组合)时落到 plan:它写不了任何东西,误触只会收紧。
 */
export function nextCycleStep(
  p: Permissions,
  planActive: boolean,
): { plan: true } | { preset: ApprovalPresetId } {
  if (planActive) return { preset: APPROVAL_PRESETS[0].id };
  const index = APPROVAL_PRESETS.findIndex(
    (x) => x.sandbox === p.sandbox && x.approval === p.approval,
  );
  if (index < 0) return { plan: true };
  const next = APPROVAL_PRESETS[index + 1];
  return next ? { preset: next.id } : { plan: true };
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

/** 时间线显示密度(/focus)。 */
export const timelineModeSchema = z.enum(['full', 'compact', 'result']);
export type TimelineMode = z.infer<typeof timelineModeSchema>;
export const TIMELINE_MODES = timelineModeSchema.options;

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
  /**
   * 无需确认的联网规则:`WebSearch`(放行搜索)或 `WebFetch(domain:example.com)`
   * (放行抓取某域名,支持 `*.example.com` 通配)。裸域名也接受,视同 WebFetch 规则。
   * 私网/云元数据地址不受此列表影响——那是硬拒,任何档位都不放行。
   */
  allowNet: z.array(z.string()).default([]),
});
export type PermissionRules = z.infer<typeof permissionRulesSchema>;

/**
 * web_search 的后端选择。`auto` 按 glm → exa 的顺序取第一个能从预设环境变量
 * 拿到 key 的;`off` 给"有 key 但不想让 agent 搜"的人一个显式关闭口。
 */
export const searchBackendSchema = z.enum(['auto', 'glm', 'exa', 'custom', 'off']);
export type SearchBackendId = z.infer<typeof searchBackendSchema>;
export const SEARCH_BACKENDS = searchBackendSchema.options;

const searchConfigShape = {
  /** 搜索后端专用的 API key。注意:`auto` 下会被忽略——见 resolveSearchBackend。 */
  apiKey: z.string().optional(),
  /** 读取搜索 key 的环境变量名,覆盖预设列表。 */
  apiKeyEnv: z.string().optional(),
  /** 覆盖预设端点;`custom` 后端必填(请求/响应契约与 GLM web_search 相同)。 */
  baseURL: z.url().optional(),
  /** GLM 的搜索引擎档位(search_std / search_pro / …),仅 glm/custom 后端使用。 */
  engine: z.string().optional(),
  /** 每次搜索返回的默认条数。 */
  count: z.number().int().min(1).max(20).optional(),
};

export const searchConfigSchema = z.object({
  backend: searchBackendSchema.default('auto'),
  ...searchConfigShape,
});
export type SearchConfig = z.infer<typeof searchConfigSchema>;

/**
 * 分层文件用的无默认版本。zod 的 `.partial()` 不摘 `.default()`——项目层只写
 * engine 时 backend 仍会被填成 'auto',深合并就把全局层显式配的后端抹掉了,
 * 所以分层 parse 必须用 backend 裸 optional 的 schema。
 */
export const searchLayerSchema = z.object({
  backend: searchBackendSchema.optional(),
  ...searchConfigShape,
});

/**
 * 单个 LSP 服务器条目。内置 id(typescript / pyright / gopls / rust-analyzer)
 * 只需写想覆盖的字段;自定义条目至少要 command 和 extensions,缺了会被
 * 静默忽略(见 LspManager.resolveDefs)。
 */
export const lspServerConfigSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** 该服务器接管的文件扩展名,含点(".ts")。覆盖内置条目时整组替换。 */
  extensions: z.array(z.string()).optional(),
  /** false 时禁用该服务器(含内置条目)。 */
  enabled: z.boolean().optional(),
  /**
   * 收到空诊断批次后再等多久(毫秒)。rust-analyzer/gopls 这类先发空批次
   * 占位的服务器在大项目上可能超过内置启发值,漏报"有错"时把它调大。
   */
  graceMs: z.number().int().positive().optional(),
});
export type LspServerConfig = z.infer<typeof lspServerConfigSchema>;

export const lspConfigSchema = z.object({
  /** write/edit 后把 LSP 诊断回喂给模型。服务器没装时静默跳过,不算失败。 */
  enabled: z.boolean().default(true),
  /** 单次等 publishDiagnostics 的毫秒数;首次调用另有握手时间(内部上限)。 */
  timeoutMs: z.number().int().positive().default(3000),
  servers: z.record(z.string(), lspServerConfigSchema).default({}),
});
export type LspConfig = z.infer<typeof lspConfigSchema>;

/** 分层文件用的无默认版本,理由同 searchLayerSchema。 */
export const lspLayerSchema = z.object({
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  servers: z.record(z.string(), lspServerConfigSchema).optional(),
});

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
    allowNet: [],
  }),
  mcpServers: z.record(z.string(), mcpServerSchema).default({}),
  /** web_search 的后端与凭据,见 config/search.ts。 */
  search: searchConfigSchema.default({ backend: 'auto' }),
  /** LSP 诊断回喂,见 src/lsp/。 */
  lsp: lspConfigSchema.default({ enabled: true, timeoutMs: 3000, servers: {} }),
  /**
   * 每轮用户输入内 agent 循环步数的硬上限。默认不设(Claude Code 同款取向:
   * 交互场景有人盯着,esc 就是刹车,失控防护交给轮内压缩与 compactThreshold;
   * 步数上限是无人值守跑法的保险丝)。`--max-steps` 与本键显式设置时生效,
   * 撞上会截停并提示发消息续跑(新轮重新计步)。
   */
  maxSteps: z.number().int().positive().optional(),
  /**
   * `/goal` 评估器用的模型 id(与会话同一个 provider)。不填则复用会话当前
   * 模型。评估只是判一次"条件达成没有",用便宜的小模型足够,但绝不预置任何
   * 具体 id——模型名变动频繁,猜错就是 404(见 README 的约定)。
   */
  goalModel: z.string().optional(),
  /**
   * 一个目标最多自动续跑多少轮。默认给得保守:10 轮无人看管的 agent 轮次在
   * 真实代码库上已经是几十万 token,宁可让用户重设一次目标,也不要一觉醒来
   * 发现额度没了。想跑长任务的人抬高它是一行配置的事。
   */
  goalMaxTurns: z.number().int().positive().max(100).default(10),
  /**
   * 子 agent(task 工具)用的模型 id(与会话同一个 provider)。不填复用会话
   * 当前模型。调研型子任务换个便宜的模型很划算;同 goalModel,绝不预置
   * 具体 id——猜错就是 404。
   */
  taskModel: z.string().optional(),
  /**
   * 子 agent 单次任务的步数上限,缺省 50(不随 maxSteps 的"默认无上限"走:
   * 子任务无人值守、结论会被当定论引用,必须有界);显式设了 maxSteps 则
   * 沿用它。撞上限时报告会被标记不完整——调研型子任务给更小的值能更早止损。
   */
  taskMaxSteps: z.number().int().positive().optional(),
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
  /** 状态栏显示的信息段,可在 /setting 设置面板里调整。 */
  statusBar: z.array(statusSegmentSchema).default([...STATUS_SEGMENTS]),
  /**
   * 时间线显示密度,/focus 或 ctrl+o 切换。full = 全量;compact = 折叠
   * 工具调用过程;result = 只看问答。`user/assistant/error/banner` 与
   * warn 级提示在任何档位都不隐藏(见 src/ui/focus.ts 的铁律注释)。
   */
  timeline: timelineModeSchema.default('full'),
  /** 会话文件保留天数,启动时清理超期未活动的会话。 */
  cleanupPeriodDays: z.number().int().positive().default(30),
});

export type Config = z.infer<typeof configSchema>;

/**
 * 分层文件用的无默认版本,与 `Config` 形状相同但所有字段可选。
 *
 * 不能直接用 `configSchema.partial()`:zod 的 `.partial()` 不摘 `.default()`,
 * 项目层只要存在任意配置文件,幻影默认值(provider:'deepseek'、language:'auto'、
 * statusBar 全量列表等)就会以更高优先级把全局层的显式配置逐次抹掉——「每次
 * 启动恢复默认模型」一类的问题即源于此。这里把带默认值的字段全部重写成裸
 * optional(search/lsp/timeline 的默认值埋在子 schema 里,整层换成无默认变体;
 * 其余字段在下方逐一手写)。将来给 configSchema 加带默认值的新字段时,记得
 * 同步到这里,否则它的幻影默认值会再次静默覆盖全局层——readLayer 还有按
 * 文件实际键过滤的第二道兜底(load.ts),漏同步不会立刻变成静默覆盖,但
 * `partialConfigSchema.parse` 自身的语义会再次不纯。漏同步会被
 * tests/config-layer-defaults.test.ts 的键集 parity 断言拦下。
 */
export const partialConfigSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  providers: z.record(z.string(), providerConfigSchema).optional(),
  sandbox: sandboxModeSchema.optional(),
  approval: approvalPolicySchema.optional(),
  plan: z.boolean().optional(),
  // permissions 各字段有同样的既有问题——项目层只写 allowBash 会把全局层的
  // denyPath 盖成空数组——但那是历史行为,修它超出本次改动范围;顶层 default
  // 剥掉后,项目层完全没写 permissions 时全局层不再被幻影空对象覆盖。
  permissions: permissionRulesSchema.optional(),
  mcpServers: z.record(z.string(), mcpServerSchema).optional(),
  // 见 searchLayerSchema 的注释:默认值埋在子 schema 里,剥顶层不够。
  search: searchLayerSchema.optional(),
  // 与 search 同理。
  lsp: lspLayerSchema.optional(),
  maxSteps: z.number().int().positive().optional(),
  goalModel: z.string().optional(),
  goalMaxTurns: z.number().int().positive().max(100).optional(),
  taskModel: z.string().optional(),
  taskMaxSteps: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  compactThreshold: z.number().min(0.1).max(0.95).optional(),
  maxContext: z.number().int().positive().optional(),
  systemPromptAppend: z.string().optional(),
  language: z.enum(['auto', 'en', 'zh-CN']).optional(),
  statusBar: z.array(statusSegmentSchema).optional(),
  // timeline 同理:`.partial()` 不摘 `.default('full')`,项目层只要存在任意
  // 配置文件,幻影 timeline:'full' 就会以更高优先级把全局保存的 /focus
  // 偏好重置。裸 optional 让「没写」真正表示「没写」。
  timeline: timelineModeSchema.optional(),
  cleanupPeriodDays: z.number().int().positive().optional(),
});
export type PartialConfig = z.input<typeof partialConfigSchema>;
