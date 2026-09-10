import { z } from 'zod';

/** 状态栏可选的信息段。状态文字本身始终显示,不在此列。枚举顺序即展示顺序。 */
export const statusSegmentSchema = z.enum(['model', 'cwd', 'think', 'context', 'total', 'todos']);
export type StatusSegment = z.infer<typeof statusSegmentSchema>;
export const STATUS_SEGMENTS = statusSegmentSchema.options;
/**
 * 配置里的 statusBar 列表:**宽容解析**,认不出的段静默丢弃而不是让整份配置
 * 报错——权限档位那一段(`mode`)随权限系统一起退役了,而它曾是默认列表的
 * 一员,几乎每份落过盘的配置里都有它。
 */
const statusBarSchema = z
  .array(z.string())
  .transform((list) =>
    list.filter((item): item is StatusSegment => (STATUS_SEGMENTS as readonly string[]).includes(item)),
  );

/** 时间线显示密度(/focus)。 */
export const timelineModeSchema = z.enum(['full', 'compact', 'result']);
export type TimelineMode = z.infer<typeof timelineModeSchema>;
export const TIMELINE_MODES = timelineModeSchema.options;

/** 模型思考强度档位。auto = 不传任何参数、交给服务端默认;off = 显式关闭思考。 */
export const reasoningEffortSchema = z.enum(['auto', 'off', 'low', 'medium', 'high', 'max']);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export const REASONING_EFFORTS = reasoningEffortSchema.options;

/** JSON 值(逐模型自定义思考参数用)。不引 ai 包的 JSONValue——配置层自持一份。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/**
 * 逐模型思考配置,两种形态:
 * - 档位字符串:该模型的默认思考档位,盖过 provider 级与全局 `reasoningEffort`,
 *   仍走 reasoningMapping 按厂商翻译,/think 也还能在会话里调;
 * - 自定义参数对象:**原样**并入请求的 providerOptions(该 provider 键下),
 *   完全替代档位映射——内置家族表达不了的思考开关(Qwen `enable_thinking`、
 *   vLLM `chat_template_kwargs`、代理网关的 `reasoning: {...}` 等)由用户自己写。
 *   选了它,档位与 /think 对该模型不再生效;deepseek 专用 SDK 只透传规范键
 *   (thinking / reasoningEffort),任意字段在那一家会被 SDK 丢弃。
 */
export const modelReasoningSchema = z.union([
  reasoningEffortSchema,
  z.record(z.string(), jsonValueSchema),
]);
export type ModelReasoning = z.infer<typeof modelReasoningSchema>;

/**
 * GUI 模型设置里逐条维护的模型条目。id 原样发往端点(GLM 系的大小写归一
 * 在 resolveProvider 里做);contextWindow 供用量计量与压缩阈值,按模型
 * 覆盖 provider 级的 `contextWindow`(见 resolveProvider 的回退链)。
 * 与「Never hardcode model IDs」不冲突:这是用户显式配置,不是代码预置。
 */
export const providerModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  /** 单次响应的最大输出 token,透传 streamText(GUI 添加模型弹窗的「高级」项)。 */
  maxOutputTokens: z.number().int().positive().optional(),
  /** 逐模型思考配置,见 modelReasoningSchema。 */
  reasoning: modelReasoningSchema.optional(),
});
export type ProviderModelEntry = z.infer<typeof providerModelSchema>;

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
  /**
   * 显式覆盖 isVisionModel 对该 provider 各模型的视觉判定,true/false 都生效
   * (预设前缀表判错时的人工纠偏)。不写则按预设的 visionModels 表走。
   */
  vision: z.boolean().optional(),
  label: z.string().optional(),
  /**
   * 该 provider 在模型选择器里展示的模型列表(GUI 模型设置维护)。配置了
   * 任意一组后,GUI 的选择器改为直接读它(同步、零探测);为空/缺省时
   * 选择器回落到 `/models` 端点探测。所有字段无默认值——providerConfigSchema
   * 被 partialConfigSchema 原样复用,带默认值会复活分层幻影覆盖。
   */
  models: z.array(providerModelSchema).optional(),
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
  /**
   * `mojocode install` 记下的扩展包(`npm:<name>[@ver]` / `git:<url>` / 绝对
   * 路径)。启动时逐个解析到磁盘目录、读它的 manifest、装载里面的扩展与
   * 技能。分层合并时两层**取并集**(项目层装的包不该把全局层的顶掉)。
   */
  packages: z.array(z.string()).default([]),
  /**
   * 额外要装载的扩展文件或目录(Pi 的 settings `extensions`),与 `-e` 同义
   * 但可持久化;相对路径按工作区根解析。分层合并同 `packages` 取并集。
   */
  extensions: z.array(z.string()).default([]),
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
   * view_image 工具(读图返回文字描述)用的视觉模型 id(与会话同一个
   * provider)。不填则回落内置预设的 visionModel(GLM 系为 glm-4.6v);当前
   * 模型不支持图片直发时,消息里的图片会降级为文件引用、由本工具按需读取。
   * 同 goalModel/taskModel,自定义覆盖绝不预置具体 id。
   */
  visionModel: z.string().optional(),
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
  statusBar: statusBarSchema.default([...STATUS_SEGMENTS]),
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
  packages: z.array(z.string()).optional(),
  extensions: z.array(z.string()).optional(),
  mcpServers: z.record(z.string(), mcpServerSchema).optional(),
  // 见 searchLayerSchema 的注释:默认值埋在子 schema 里,剥顶层不够。
  search: searchLayerSchema.optional(),
  // 与 search 同理。
  lsp: lspLayerSchema.optional(),
  maxSteps: z.number().int().positive().optional(),
  goalModel: z.string().optional(),
  goalMaxTurns: z.number().int().positive().max(100).optional(),
  taskModel: z.string().optional(),
  visionModel: z.string().optional(),
  taskMaxSteps: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  compactThreshold: z.number().min(0.1).max(0.95).optional(),
  maxContext: z.number().int().positive().optional(),
  systemPromptAppend: z.string().optional(),
  language: z.enum(['auto', 'en', 'zh-CN']).optional(),
  statusBar: statusBarSchema.optional(),
  // timeline 同理:`.partial()` 不摘 `.default('full')`,项目层只要存在任意
  // 配置文件,幻影 timeline:'full' 就会以更高优先级把全局保存的 /focus
  // 偏好重置。裸 optional 让「没写」真正表示「没写」。
  timeline: timelineModeSchema.optional(),
  cleanupPeriodDays: z.number().int().positive().optional(),
});
export type PartialConfig = z.input<typeof partialConfigSchema>;
