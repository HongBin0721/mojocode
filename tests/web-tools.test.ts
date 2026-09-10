import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebTools } from '../src/extensions/web/tools.js';
import { runSearch } from '../src/extensions/web/backends.js';
import type { ResolvedSearchBackend } from '../src/config/search.js';
import type { WebToolDeps } from '../src/extensions/web/tools.js';

const GLM_BACKEND: ResolvedSearchBackend = {
  id: 'glm',
  label: 'GLM Web Search (智谱)',
  endpoint: 'https://open.bigmodel.cn/api/paas/v4/web_search',
  apiKey: 'glm-key',
  auth: 'bearer',
};

const EXA_BACKEND: ResolvedSearchBackend = {
  id: 'exa',
  label: 'Exa',
  endpoint: 'https://api.exa.ai/search',
  apiKey: 'exa-key',
  auth: 'x-api-key',
};

/** web 工具只要搜索后端一样东西(见 WebToolDeps),不收整个 ToolContext。 */
function makeCtx(backend: ResolvedSearchBackend | undefined) {
  const ctx: WebToolDeps = { searchBackend: () => backend };
  return { ctx };
}

type Execute = (input: Record<string, unknown>, options: unknown) => Promise<Record<string, unknown>>;
function executeOf(tool: unknown): Execute {
  return (tool as { execute: Execute }).execute;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWebTools 注册', () => {
  it('无搜索后端时只有 web_fetch;有后端时两个都在', () => {
    expect(Object.keys(createWebTools(makeCtx(undefined).ctx))).toEqual(['web_fetch']);
    expect(Object.keys(createWebTools(makeCtx(GLM_BACKEND).ctx)).sort()).toEqual([
      'web_fetch',
      'web_search',
    ]);
  });
});

describe('runSearch 适配器', () => {
  it('GLM:请求形状(70 字符截断、Bearer、recency 映射)与响应映射', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        search_result: [
          {
            title: 'T1',
            link: 'https://a.dev/1',
            content: 'C1',
            publish_date: '2026-08-01',
            media: 'a.dev',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const longQuery = 'q'.repeat(100);
    const results = await runSearch(
      GLM_BACKEND,
      { query: longQuery, count: 5, domain: 'a.dev', recency: 'week' },
      AbortSignal.timeout(1000),
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GLM_BACKEND.endpoint);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer glm-key');
    const body = JSON.parse(init.body as string);
    expect(body.search_query).toHaveLength(70);
    expect(body.search_engine).toBe('search_std');
    expect(body.search_domain_filter).toBe('a.dev');
    expect(body.search_recency_filter).toBe('oneWeek');

    expect(results).toEqual([
      {
        title: 'T1',
        url: 'https://a.dev/1',
        snippet: 'C1',
        publishedDate: '2026-08-01',
        source: 'a.dev',
      },
    ]);
  });

  it('Exa:x-api-key 头与 results[] 映射;空结果返回空数组', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ results: [{ title: 'E', url: 'https://e.dev', text: 'body' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const results = await runSearch(EXA_BACKEND, { query: 'q', count: 3 }, AbortSignal.timeout(1000));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('exa-key');
    expect(JSON.parse(init.body as string).numResults).toBe(3);
    expect(results).toEqual([{ title: 'E', url: 'https://e.dev', snippet: 'body' }]);

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })));
    expect(await runSearch(EXA_BACKEND, { query: 'q', count: 3 }, AbortSignal.timeout(1000))).toEqual([]);
  });

  it('非 2xx 抛英文错误,401 附 key 提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    await expect(
      runSearch(GLM_BACKEND, { query: 'q', count: 1 }, AbortSignal.timeout(1000)),
    ).rejects.toThrow(/HTTP 401.*key is invalid or out of quota/s);
  });
});

describe('web_search 工具', () => {
  it('成功返回结果对象', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ search_result: [{ title: 'T', link: 'https://x.dev', content: 'c' }] })),
    );
    const { ctx } = makeCtx(GLM_BACKEND);
    const tools = createWebTools(ctx);
    const out = await executeOf(tools.web_search)({ query: 'hello' }, {});
    expect(out.backend).toBe('glm');
    expect(out.count).toBe(1);
  });


  it('空结果带提示信息', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ search_result: [] })));
    const tools = createWebTools(makeCtx(GLM_BACKEND).ctx);
    const out = await executeOf(tools.web_search)({ query: 'q' }, {});
    expect(out.count).toBe(0);
    expect(out.message).toMatch(/No results/);
  });
});

describe('web_fetch 工具', () => {
  it('HTML 转 Markdown,抽 title', async () => {
    const html =
      '<html><head><title>My Doc</title></head><body><h1>Hello</h1><p>World <a href="https://x.dev">link</a></p><script>evil()</script></body></html>';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })),
    );
    const { ctx } = makeCtx(undefined);
    const tools = createWebTools(ctx);
    const out = await executeOf(tools.web_fetch)({ url: 'https://docs.foo.dev/a' }, {});
    expect(out.title).toBe('My Doc');
    expect(out.content).toContain('# Hello');
    expect(out.content).toContain('[link](https://x.dev)');
    expect(out.content).not.toContain('evil()');
  });

  it('JSON 原样返回;二进制类型返回 unsupported 对象', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    const tools = createWebTools(makeCtx(undefined).ctx);
    const out = await executeOf(tools.web_fetch)({ url: 'https://api.foo.dev/x' }, {});
    expect(out.content).toBe('{"a":1}');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/png' } })),
    );
    const out2 = await executeOf(tools.web_fetch)({ url: 'https://img.foo.dev/x.png' }, {});
    expect(out2.unsupported).toBe(true);
  });

  it('4xx 返回对象(含正文与 message),不抛错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not here', { status: 404, statusText: 'Not Found', headers: { 'content-type': 'text/plain' } })),
    );
    const tools = createWebTools(makeCtx(undefined).ctx);
    const out = await executeOf(tools.web_fetch)({ url: 'https://foo.dev/missing' }, {});
    expect(out.status).toBe(404);
    expect(out.message).toMatch(/404/);
    expect(out.content).toBe('not here');
  });




  it('跨站重定向后的落点以 finalUrl 报出(fetch 自己跟随重定向)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const res = new Response('<html><body>ok</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
        Object.defineProperty(res, 'url', { value: 'https://other.dev/final' });
        return res;
      }),
    );
    const out = await executeOf(createWebTools(makeCtx(undefined).ctx).web_fetch)(
      { url: 'https://docs.foo.dev/a' },
      {},
    );
    expect(out.finalUrl).toBe('https://other.dev/final');
  });

  it('正文读取阶段超时也返回 timedOut 对象,不抛裸 TimeoutError', async () => {
    // 先回 header,再在 body 上超时——之前 readCapped 在 try/catch 之外,
    // 这个 DOMException 会直接漏成不透明的工具报错。
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
        // 永不 close,读第二块时抛超时
      },
      pull() {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        throw err;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })),
    );
    const tools = createWebTools(makeCtx(undefined).ctx);
    const out = await executeOf(tools.web_fetch)({ url: 'https://slow.dev/x' }, {});
    expect(out.timedOut).toBe(true);
    expect(out.message).toMatch(/body/);
  });

  it('DNS/连接失败抛带补救提示的错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND nope.invalid') });
      }),
    );
    const tools = createWebTools(makeCtx(undefined).ctx);
    await expect(executeOf(tools.web_fetch)({ url: 'https://nope.invalid/' }, {})).rejects.toThrow(
      /ENOTFOUND.*unreachable/s,
    );
  });

  it('maxChars 截断并标记 truncated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(5000), { status: 200, headers: { 'content-type': 'text/plain' } })),
    );
    const tools = createWebTools(makeCtx(undefined).ctx);
    const out = await executeOf(tools.web_fetch)({ url: 'https://foo.dev/big', maxChars: 1000 }, {});
    expect((out.content as string).length).toBeLessThan(1100); // 1000 + 截断提示行
    expect(out.truncated).toBe(true);
  });
});
