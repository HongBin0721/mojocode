import { z } from 'zod';

export const permissionModeSchema = z.enum(['readonly', 'ask', 'acceptEdits', 'yolo']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

/** 状态栏可选的信息段。状态文字本身始终显示,不在此列。枚举顺序即展示顺序,mode 固定排第一。 */
export const statusSegmentSchema = z.enum(['mode', 'model', 'think', 'context', 'total', 'todos']);
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
  permissionMode: permissionModeSchema.default('ask'),
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
