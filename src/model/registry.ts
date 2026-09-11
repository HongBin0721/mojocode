import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';
import {
  isProviderConfigured,
  isProviderEligible,
  resolveProvider,
  type ResolvedProvider,
} from '../config/load.js';
import {
  BUILTIN_PROVIDER_IDS,
  isBuiltinProvider,
  normalizeModelId,
  PROVIDER_PRESETS,
} from '../config/providers.js';
import type { Config, ProviderConfig } from '../config/schema.js';

/**
 * 为解析后的 provider 构建 AI SDK 语言模型。
 *
 * DeepSeek 使用其专用包,这样 `reasoning_content` 能被映射为正规的
 * reasoning 部分。其余都走通用的 OpenAI 兼容 provider,baseURL 原样使用
 * (参见 providers.ts 中关于 GLM `/api/paas/v4` 路径的说明)。
 */
export function createModel(provider: ResolvedProvider): LanguageModel {
  if (provider.sdk === 'deepseek') {
    const deepseek = createDeepSeek({
      apiKey: provider.apiKey,
      baseURL: provider.baseURL,
      headers: provider.headers,
    });
    return deepseek(provider.model);
  }

  const compatible = createOpenAICompatible({
    name: provider.id,
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    headers: provider.headers,
    // 不开这个开关,流式响应就没有 usage 块,每步 token 数全是 undefined,
    // 状态栏的上下文/累计计数会一直停在 0(DeepSeek 专用包是默认开启的)。
    includeUsage: true,
  });
  return compatible(provider.model);
}

export interface ModelInfo {
  id: string;
  ownedBy?: string;
}

/** Error 的 cause 链(最多 4 层),probeModels 的详情格式化用。 */
function* causeChain(err: unknown): Generator<Error> {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

/**
 * 展开 Error 的 cause 链。undici 抛出来的顶层消息永远是干巴巴的
 * `fetch failed`,真正有用的 ENOTFOUND / ECONNREFUSED / 自签证书 / 代理拒绝
 * 全在 `cause` 里——而这恰恰是 `doctor` 存在的意义,不能丢。
 */
function errorChain(err: unknown): string {
  const parts: string[] = [];
  for (const current of causeChain(err)) {
    const code = (current as NodeJS.ErrnoException).code;
    const text = code && !current.message.includes(code) ? `${current.message} (${code})` : current.message;
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.length > 0 ? parts.join(' ← ') : String(err);
}

/** `{baseURL}/{path}`,去掉 baseURL 尾斜杠。 */
function endpointUrl(provider: ResolvedProvider, path: string): string {
  return `${provider.baseURL.replace(/\/$/, '')}/${path}`;
}

/** 认证头:无凭据的本地端点不发 Authorization(空 Bearer 会被部分服务端拒掉)。 */
function authHeaders(provider: ResolvedProvider): Record<string, string> {
  return {
    ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    ...provider.headers,
  };
}

/** 一次 `/models` 探测的结果。失败也是正常返回值——`doctor` 要报告失败详情。 */
export interface ModelProbe {
  url: string;
  /** 拿到 HTTP 响应时的状态码;连接层面就失败(DNS/超时)时为 undefined。 */
  status?: number;
  ok: boolean;
  models?: ModelInfo[];
  /** 失败原因,已格式化成可直接展示的一行(或多行)。 */
  error?: string;
  durationMs: number;
}

export interface ProbeOptions {
  signal?: AbortSignal;
  /** 注入用,便于测试;默认全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/**
 * 请求 `GET {baseURL}/models` 并把结果(含失败)原样返回。
 * `listModels` 在此之上抛错,`doctor` 则据此区分 401(密钥问题)与
 * 404(端点不提供列表,不代表不能对话)。
 */
export async function probeModels(
  provider: ResolvedProvider,
  options: ProbeOptions = {},
): Promise<ModelProbe> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = endpointUrl(provider, 'models');
  const started = Date.now();
  const done = (rest: Omit<ModelProbe, 'url' | 'durationMs'>): ModelProbe => ({
    url,
    durationMs: Date.now() - started,
    ...rest,
  });

  let res: Response;
  try {
    res = await doFetch(url, {
      headers: authHeaders(provider),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    return done({ ok: false, error: `GET ${url} failed: ${errorChain(err)}` });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return done({
      ok: false,
      status: res.status,
      error: `GET ${url} failed: ${res.status} ${res.statusText}${body ? `\n${body.slice(0, 500)}` : ''}`,
    });
  }

  let json: { data?: Array<{ id?: string; owned_by?: string }> };
  try {
    json = (await res.json()) as typeof json;
  } catch (err) {
    return done({
      ok: false,
      status: res.status,
      error: `GET ${url} returned invalid JSON: ${(err as Error).message}`,
    });
  }
  if (!Array.isArray(json.data)) {
    return done({
      ok: false,
      status: res.status,
      error: `GET ${url} returned an unexpected shape (no "data" array).`,
    });
  }

  return done({
    ok: true,
    status: res.status,
    models: json.data
      .filter((m): m is { id: string; owned_by?: string } => typeof m.id === 'string')
      // GLM 系端点回的是小写 id,归一成与预设一致的大写拼写。
      .map((m) => ({ id: normalizeModelId(provider.id, m.id), ownedBy: m.owned_by }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

/**
 * 线上 `/models` 列表可能滞后于实际可用的模型(智谱 Coding Plan 上线初期
 * 列表里没有最新的 glm,但对话端点已可用)。预设的 defaultModel 是发布时
 * 确认存在的起点,列表里缺它就并入——默认模型必须永远可选。
 */
export function ensurePresetDefault(models: ModelInfo[], providerId: string): ModelInfo[] {
  if (!isBuiltinProvider(providerId)) return models;
  const preset = PROVIDER_PRESETS[providerId];
  if (models.some((m) => m.id === preset.defaultModel)) return models;
  return [...models, { id: preset.defaultModel }].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 请求 `GET {baseURL}/models`。供 `mojocode models` 使用,让用户能查到自己的
 * key 实际拥有的模型 id,而不是去猜那些变化频繁的名字。
 */
export async function listModels(
  provider: ResolvedProvider,
  options?: ProbeOptions,
): Promise<ModelInfo[]> {
  const probe = await probeModels(provider, options);
  if (!probe.ok) throw new Error(probe.error);
  return ensurePresetDefault(probe.models ?? [], provider.id);
}

/** `/models` 分组选择器里一个厂商的数据。凭据一律不随组外带。 */
export interface ProviderModels {
  providerId: string;
  label: string;
  /** 已知模型的上下文窗口(内置预设才有),UI 换算成行尾标注。 */
  contextWindows?: Record<string, number>;
  models: ModelInfo[];
  /** 列表拉取失败时的一行原因(models 可能是预设已知模型的兜底)。 */
  error?: string;
}

export interface ListProviderModelsOptions extends ProbeOptions {
  /** 注入用,便于测试;默认 process.env。 */
  env?: NodeJS.ProcessEnv;
  /** 单个探测的兜底超时(毫秒),默认 PROBE_TIMEOUT_MS;与调用方 signal 并联。 */
  timeoutMs?: number;
}

/**
 * 单个 `/models` 探测的兜底超时。黑洞 TCP(下线的本地端点、被防火墙丢包的
 * IP)会让 fetch 挂到 undici 的 ~300s 才断,而 listProviderModels 是客户端
 * 串行 RPC 队列上的**即时**调用——一个死端点挂住的不只是选择器,还有排在
 * 它后面的所有 RPC(包括用户放弃后提交的那条消息)。
 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * 枚举**已配置**的厂商(内置预设凭 env/配置文件里的 key 判定,自定义条目
 * 有 baseURL 即算)并**并发**探测各自的 `/models`。单个厂商失败不抛错——
 * 就地带回原因,内置预设退回 `contextWindows` 里已知的老模型,让选择器
 * 依旧可用(手动输入行是最终兜底)。
 *
 * 当前 provider 永远排第一组,其余按预设顺序 + 自定义条目顺序;解析不出
 * (缺 key、自定义条目没 model)的条目直接跳过——它们本来也无法被切换过去。
 */
/**
 * 能切过去的厂商 id,**当前厂商永远排第一**,其余按配置条目顺序 + 预设顺序。
 * 准入是 config 层的 `isProviderEligible`(显式配置过,或内置厂商的预设 env
 * 变量扫到了 key)。
 *
 * 独立成函数是因为有两个消费方:`/models` 的探测(下面)与扩展的
 * `ctx.modelRegistry.getProviders()`。"哪些厂商存在、按什么顺序"曾在
 * bootstrap 里被重写过一遍——共用的谓词挡不住各写一遍的**枚举**。
 *
 * `explicit` 收的是"显式配置过"的那批:它们的 key 是用户自己写的,探测被拒
 * 也留着;仅凭共享 env 变量顺带命中的,探测被拒时整组丢弃(见结果映射处)。
 */
export function eligibleProviderIds(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): { ids: string[]; explicit: Set<string> } {
  const ids: string[] = [config.provider];
  const seen = new Set(ids);
  const explicit = new Set(ids);
  const tryAdd = (id: string, override?: ProviderConfig): void => {
    if (seen.has(id) || !isProviderEligible(id, override, env)) return;
    seen.add(id);
    ids.push(id);
    // "已配置"的判定链住在 config 层(resolveProvider 旁),这里只消费。
    if (override && isProviderConfigured(id, override, env)) explicit.add(id);
  };
  for (const [id, override] of Object.entries(config.providers)) {
    if (override) tryAdd(id, override);
  }
  for (const id of BUILTIN_PROVIDER_IDS) tryAdd(id);
  return { ids, explicit };
}

/** 模型表里的一条(预设的 contextWindows / 默认模型,或配置 `providers.<id>.models`)。 */
export interface KnownModel {
  provider: string;
  id: string;
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/**
 * **不联网**就能知道的模型:预设的 contextWindows 表 + 默认模型打底,配置
 * `providers.<id>.models` 同 id 覆盖。在线列表走 `listProviderModels`。
 *
 * 与 `ensurePresetDefault` 比邻而居是有意的——"这个厂商有哪些模型"的离线
 * 答案只允许有一处;它曾被抄进 bootstrap 一份,于是 `/models` 的离线兜底与
 * 扩展的 `ctx.modelRegistry.getModels()` 是两条代码路径。id 一律过
 * `normalizeModelId`,与 resolveProvider 查 contextWindows 时同一条归一
 * (GLM 的大小写写法因此不会在这里查不到而在别处查得到)。
 */
export function knownProviderModels(config: Config, providerId?: string): KnownModel[] {
  const ids = providerId
    ? [providerId]
    : [...new Set([config.provider, ...Object.keys(config.providers), ...BUILTIN_PROVIDER_IDS])];
  const out: KnownModel[] = [];
  for (const id of ids) {
    const byModel = new Map<string, KnownModel>();
    if (isBuiltinProvider(id)) {
      const preset = PROVIDER_PRESETS[id];
      for (const [modelId, contextWindow] of Object.entries(preset.contextWindows)) {
        byModel.set(normalizeModelId(id, modelId), { provider: id, id: modelId, contextWindow });
      }
      const defaultKey = normalizeModelId(id, preset.defaultModel);
      if (!byModel.has(defaultKey)) byModel.set(defaultKey, { provider: id, id: preset.defaultModel });
    }
    for (const entry of config.providers[id]?.models ?? []) {
      byModel.set(normalizeModelId(id, entry.id), {
        provider: id,
        id: entry.id,
        ...(entry.label !== undefined ? { label: entry.label } : {}),
        ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
        ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
      });
    }
    out.push(...byModel.values());
  }
  return out;
}

export async function listProviderModels(
  config: Config,
  options: ListProviderModelsOptions = {},
): Promise<ProviderModels[]> {
  const env = options.env ?? process.env;
  const { ids, explicit } = eligibleProviderIds(config, env);

  // 显式标注 U:catch 分支的 `[]` 会让 flatMap 的类型推断退化成 unknown。
  const resolved: ResolvedProvider[] = ids.flatMap<ResolvedProvider>((id) => {
    try {
      // model 置空:逐组解析只关心 baseURL/key,模型回退到该厂商自己的
      // override/预设默认值,顶层 model 覆盖属于(可能是另一个)厂商。
      // probe 模式下缺 key、缺 model 都放行(探测不读 model,缺 key 让端点
      // 用 401 回答),字段回退顺序与真正对话的 resolveProvider 是同一份。
      return [resolveProvider({ ...config, provider: id, model: undefined }, env, { probe: true })];
    } catch {
      // probe 模式下只剩"连 baseURL 都没有"会抛——条目无从探测,跳过。
      return [];
    }
  });

  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  // 探测与组构造并进同一个 map:成功/失败两个分支共享的字段只写一次,
  // 也免去"两个数组必须同序"的下标对齐。
  const groups = await Promise.all(
    resolved.map(async (provider): Promise<ProviderModels[]> => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const probe = await probeModels(provider, { ...options, signal });
      const preset = isBuiltinProvider(provider.id) ? PROVIDER_PRESETS[provider.id] : undefined;
      const base = {
        providerId: provider.id,
        label: provider.label,
        // 已知模型的上下文窗口(内置预设才有),UI 换算成行尾标注。
        contextWindows: preset ? { ...preset.contextWindows } : undefined,
      };
      if (probe.ok) {
        // 线上列表滞后时并入预设默认模型(见 ensurePresetDefault 的说明)。
        return [{ ...base, models: ensurePresetDefault(probe.models ?? [], provider.id) }];
      }
      // 仅凭共享 env 变量扫进来的兄弟厂商(ZHIPU_API_KEY 同时挂在 glm /
      // glm-coding / glm-intl 的预设上,MOONSHOT_API_KEY 同理配对 kimi 系),
      // key 被端点判 401/403 说明它不属于这家——预设兜底行会渲染成"可选却
      // 必 401"的陷阱,整组丢弃。显式配置过的组保留兜底与失败原因。
      if (!explicit.has(provider.id) && (probe.status === 401 || probe.status === 403)) {
        return [];
      }
      return [
        {
          ...base,
          // 探测失败:退回预设已知模型(contextWindows 含默认模型),原因只取
          // 第一行(错误正文可能带响应体)。
          models: (preset ? Object.keys(preset.contextWindows) : []).map((id) => ({ id })),
          error: probe.error?.split('\n')[0],
        },
      ];
    }),
  );
  return groups.flat();
}
