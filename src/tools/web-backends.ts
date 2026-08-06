/**
 * web_search 的后端适配器:把各家搜索 API 的请求/响应归一成 SearchResult[]。
 * 独立成文件是为了单测——工具层 mock 掉整个适配器,适配器自己 mock fetch。
 *
 * 形状均已对照官方文档核对(2026-08):GLM 的 search_recency_filter 枚举为
 * oneDay/oneWeek/oneMonth/oneYear/noLimit,响应顶层是 search_result[];
 * Exa 认 x-api-key 头,响应顶层是 results[]。
 */

import type { ResolvedSearchBackend } from '../config/search.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  source?: string;
}

export interface SearchParams {
  query: string;
  count: number;
  domain?: string;
  recency?: 'day' | 'week' | 'month' | 'year';
}

/** 单条摘要的长度上限,防止一次搜索的结果撑爆工具输出。 */
const MAX_SNIPPET_CHARS = 500;

export async function runSearch(
  backend: ResolvedSearchBackend,
  params: SearchParams,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  // custom 契约与 GLM 相同(README 有说明),复用同一个适配器。
  if (backend.id === 'exa') return searchWithExa(backend, params, signal);
  return searchWithGlm(backend, params, signal);
}

const GLM_RECENCY: Record<NonNullable<SearchParams['recency']>, string> = {
  day: 'oneDay',
  week: 'oneWeek',
  month: 'oneMonth',
  year: 'oneYear',
};

async function searchWithGlm(
  backend: ResolvedSearchBackend,
  params: SearchParams,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const body = {
    // GLM 限 70 字符,静默截断而非报错;schema 的 description 已提示模型
    // 用短 query。截断损伤检索质量的话,再改成 throw 引导重试。
    search_query: params.query.slice(0, 70),
    search_engine: backend.engine ?? 'search_std',
    count: params.count,
    ...(params.domain ? { search_domain_filter: params.domain } : {}),
    ...(params.recency ? { search_recency_filter: GLM_RECENCY[params.recency] } : {}),
    content_size: 'medium',
  };

  const json = await postJson(backend, body, signal);
  const results = (json as { search_result?: unknown }).search_result;
  if (!Array.isArray(results)) return [];
  return results.map((item) => {
    const r = item as Record<string, unknown>;
    return {
      title: str(r.title),
      url: str(r.link),
      snippet: str(r.content).slice(0, MAX_SNIPPET_CHARS),
      ...(r.publish_date ? { publishedDate: str(r.publish_date) } : {}),
      ...(r.media ? { source: str(r.media) } : {}),
    };
  });
}

async function searchWithExa(
  backend: ResolvedSearchBackend,
  params: SearchParams,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const body = {
    query: params.query,
    numResults: params.count,
    type: 'auto',
    contents: { text: { maxCharacters: MAX_SNIPPET_CHARS } },
    ...(params.domain ? { includeDomains: [params.domain] } : {}),
    ...(params.recency ? { startPublishedDate: recencyToIso(params.recency) } : {}),
  };

  const json = await postJson(backend, body, signal);
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results.map((item) => {
    const r = item as Record<string, unknown>;
    return {
      title: str(r.title),
      url: str(r.url),
      snippet: str(r.text).slice(0, MAX_SNIPPET_CHARS),
      ...(r.publishedDate ? { publishedDate: str(r.publishedDate) } : {}),
    };
  });
}

async function postJson(
  backend: ResolvedSearchBackend,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (backend.auth === 'x-api-key') headers['x-api-key'] = backend.apiKey;
  else headers.authorization = `Bearer ${backend.apiKey}`;

  const res = await fetch(backend.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    const hint =
      res.status === 401 || res.status === 403
        ? ' The search API key is invalid or out of quota.'
        : '';
    throw new Error(`Web search failed: ${backend.id} returned HTTP ${res.status}: ${text}.${hint}`);
  }
  return res.json();
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function recencyToIso(recency: NonNullable<SearchParams['recency']>): string {
  const days = { day: 1, week: 7, month: 30, year: 365 }[recency];
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
