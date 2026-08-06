import { tool } from 'ai';
import { z } from 'zod';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { hostOf } from '../permissions/net-rules.js';
import { PermissionDeniedError } from '../permissions/gate.js';
import { packageVersion } from '../config/version.js';
import { runSearch } from './web-backends.js';
import { MAX_OUTPUT_CHARS, truncate, type ToolContext } from './context.js';

const SEARCH_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 30_000;
/** 流式读取的字节上限,先于 truncate 的字符上限,防超大响应占内存。 */
const MAX_FETCH_BYTES = 4 * 1024 * 1024;
/** 手动跟随重定向的跳数上限,防重定向环。 */
const MAX_REDIRECTS = 5;

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * 联网工具。web_search 仅在解析出搜索后端时注册(缺 key 降级,doctor 负责
 * 解释);web_fetch 零依赖恒注册。两者的权限都收敛在 gate.checkNet 一个卡口。
 */
export function createWebTools(ctx: ToolContext) {
  // 注册时机一次性求值:后端与 provider 工具同生命周期(/new 重建时再取)。
  const searchAvailable = ctx.searchBackend() !== undefined;
  return {
    web_fetch: createFetchTool(ctx),
    ...(searchAvailable ? { web_search: createSearchTool(ctx) } : {}),
  };
}

function createSearchTool(ctx: ToolContext) {
  return tool({
    description:
      'Search the web. Returns result titles, URLs and text snippets from a search API. Use it ' +
      'for current information, library documentation, or error messages you do not recognize. ' +
      'Snippets are short — follow up with web_fetch on a promising URL to read the full page ' +
      'before relying on it.',
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(200)
        .describe(
          'The search query. Keep it short and keyword-focused; some backends truncate beyond 70 characters.',
        ),
      count: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Number of results to return (default 5).'),
      domain: z
        .string()
        .optional()
        .describe('Restrict results to a single domain, e.g. "github.com".'),
      recency: z
        .enum(['day', 'week', 'month', 'year'])
        .optional()
        .describe('Only include pages published within this window.'),
    }),
    execute: async ({ query, count, domain, recency }, { abortSignal }) => {
      const backend = ctx.searchBackend();
      if (!backend) {
        // 会话中途 key 失效(如 /provider 切走了 GLM)才会走到这里。
        throw new Error(
          'Web search is not configured: no search backend has an API key. ' +
            'Ask the user to set ZHIPU_API_KEY / EXA_API_KEY or configure search in config.json.',
        );
      }

      await ctx.gate.checkNet({ tool: 'web_search', query });

      try {
        const results = await runSearch(
          backend,
          { query, count: count ?? backend.count ?? 5, ...(domain ? { domain } : {}), ...(recency ? { recency } : {}) },
          combineSignals(abortSignal, SEARCH_TIMEOUT_MS),
        );
        if (results.length === 0) {
          return {
            backend: backend.id,
            query,
            count: 0,
            results: [],
            message: 'No results. Try different keywords.',
          };
        }
        return { backend: backend.id, query, count: results.length, results };
      } catch (err) {
        if (isTimeout(err)) {
          return {
            backend: backend.id,
            query,
            timedOut: true,
            message: `The search request timed out after ${SEARCH_TIMEOUT_MS / 1000}s. Try again or narrow the query.`,
          };
        }
        throw err;
      }
    },
  });
}

function createFetchTool(ctx: ToolContext) {
  const nhm = new NodeHtmlMarkdown({ ignore: ['script', 'style', 'noscript', 'iframe'] });

  return tool({
    description:
      'Fetch a URL and return its content. HTML is converted to Markdown; plain text, JSON, XML ' +
      'and other text types are returned as-is. Use it to read documentation, articles, raw ' +
      'files, or URLs returned by web_search. Output is truncated to 30000 characters and ' +
      'binary content is not supported.',
    inputSchema: z.object({
      url: z.url().describe('The http(s) URL to fetch.'),
      maxChars: z
        .number()
        .int()
        .min(1000)
        .max(MAX_OUTPUT_CHARS)
        .optional()
        .describe(`Truncate the returned content to this many characters (default ${MAX_OUTPUT_CHARS}).`),
    }),
    execute: async ({ url, maxChars }, { abortSignal }) => {
      await ctx.gate.checkNet({ tool: 'web_fetch', url });

      const signal = combineSignals(abortSignal, FETCH_TIMEOUT_MS);
      let res: Response;
      let finalUrl = url;
      try {
        // redirect: 'manual' 而不是 'follow':'follow' 会先把每一跳都真的请求
        // 出去,等 undici 拿到最终响应我们才有机会鉴权——跳到 169.254.169.254
        // 的那次请求已经发生了(内网 GET 的副作用、存在性与耗时侧信道都留下了)。
        // 手动逐跳:每个 Location 先过 checkNet,批准了才请求。
        for (let hop = 0; ; hop += 1) {
          res = await fetch(finalUrl, {
            redirect: 'manual',
            signal,
            // 永不携带 cookie 或任何认证头——这个工具只该看到公开内容。
            headers: {
              'user-agent': `mojocode/${packageVersion()}`,
              accept: 'text/html,text/*;q=0.9,application/json;q=0.8,*/*;q=0.5',
            },
          });
          const location = isRedirectStatus(res.status) ? res.headers.get('location') : null;
          if (!location) break;

          const next = new URL(location, finalUrl).toString();
          await res.body?.cancel().catch(() => {});
          if (hop >= MAX_REDIRECTS) {
            throw new Error(
              `Fetch failed: more than ${MAX_REDIRECTS} redirects starting at ${url}. The URL may be looping.`,
            );
          }
          // 跳到别的域名要重新确认,跳到私网/云元数据会被硬拒——都在请求发出之前。
          await ctx.gate.checkNet({ tool: 'web_fetch', url: next });
          finalUrl = next;
        }
      } catch (err) {
        if (isTimeout(err)) {
          return { url, timedOut: true, message: `Fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s.` };
        }
        if (isAbort(err) || err instanceof PermissionDeniedError) throw err;
        if (err instanceof Error && err.message.startsWith('Fetch failed:')) throw err;
        throw new Error(
          `Fetch failed: ${(err as Error).cause instanceof Error ? ((err as Error).cause as Error).message : (err as Error).message}. ` +
            'Check the URL, or the host may be unreachable from this machine.',
        );
      }

      const crossedHost = hostOf(finalUrl) !== hostOf(url);

      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      const kind = classifyContentType(contentType);
      if (kind === 'binary') {
        res.body?.cancel().catch(() => {});
        return {
          url,
          status: res.status,
          contentType,
          unsupported: true,
          message: 'Unsupported content type; only text and HTML can be fetched.',
        };
      }

      // 读正文也在同一个 signal 下:先回 header 再挤牙膏的服务器会在这里超时,
      // 不放进 try 的话就是一个没人处理的裸 TimeoutError 抛给模型。
      let raw: string;
      let capped: boolean;
      try {
        ({ text: raw, capped } = await readCapped(res, MAX_FETCH_BYTES));
      } catch (err) {
        if (isTimeout(err)) {
          return {
            url,
            timedOut: true,
            message: `Fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s while reading the response body.`,
          };
        }
        throw err;
      }

      let title: string | undefined;
      let text = raw;
      if (kind === 'html') {
        title = /<title[^>]*>([^<]*)<\/title>/i.exec(raw)?.[1]?.trim() || undefined;
        text = nhm.translate(raw);
      }

      const limit = maxChars ?? MAX_OUTPUT_CHARS;
      const content = truncate(text.trim(), limit);
      const result = {
        url,
        ...(crossedHost ? { finalUrl } : {}),
        status: res.status,
        contentType,
        ...(title ? { title } : {}),
        content,
        truncated: capped || text.length > limit,
      };
      // 4xx/5xx 也返回正文(错误页常有信息量),只是附带说明,不抛错。
      if (res.status >= 400) {
        return { ...result, message: `HTTP ${res.status} ${res.statusText}`.trim() };
      }
      return result;
    },
  });
}

/** 用户中断信号(可能不存在)与超时信号的合成。 */
function combineSignals(abortSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
}

/** AbortSignal.timeout 的中止理由是名为 TimeoutError 的 DOMException。 */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function classifyContentType(contentType: string): 'html' | 'text' | 'binary' {
  const mime = contentType.split(';')[0]!.trim();
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml') ||
    mime === '' // 无 content-type 时按文本尝试,读出来的乱码由模型自行判断
  ) {
    return 'text';
  }
  return 'binary';
}

/** 流式读取响应正文,超过字节上限即取消并标记。res.text() 会一口气读完,没有上限。 */
async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; capped: boolean }> {
  if (!res.body) return { text: '', capped: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder(); // 按规范恒 UTF-8;非 UTF-8 旧页面会乱码,第一版接受
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      text += decoder.decode(value.subarray(0, value.byteLength - (bytes - maxBytes)), { stream: true });
      await reader.cancel().catch(() => {});
      return { text, capped: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, capped: false };
}
