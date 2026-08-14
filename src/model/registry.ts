import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';
import type { ResolvedProvider } from '../config/load.js';

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

/**
 * 展开 Error 的 cause 链。undici 抛出来的顶层消息永远是干巴巴的
 * `fetch failed`,真正有用的 ENOTFOUND / ECONNREFUSED / 自签证书 / 代理拒绝
 * 全在 `cause` 里——而这恰恰是 `doctor` 存在的意义,不能丢。
 */
function errorChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    const text = code && !current.message.includes(code) ? `${current.message} (${code})` : current.message;
    if (text && !parts.includes(text)) parts.push(text);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.length > 0 ? parts.join(' ← ') : String(err);
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
  const url = `${provider.baseURL.replace(/\/$/, '')}/models`;
  const started = Date.now();
  const done = (rest: Omit<ModelProbe, 'url' | 'durationMs'>): ModelProbe => ({
    url,
    durationMs: Date.now() - started,
    ...rest,
  });

  let res: Response;
  try {
    res = await doFetch(url, {
      headers: {
        // 无凭据的本地端点不发 Authorization(空 Bearer 会被部分服务端拒掉)。
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        ...provider.headers,
      },
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
      .map((m) => ({ id: m.id, ownedBy: m.owned_by }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
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
  return probe.models ?? [];
}
