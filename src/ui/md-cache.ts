import { renderMarkdownAnsi } from './markdown-ansi.js';

/**
 * renderMarkdownAnsi 的按条目记忆化。
 *
 * Ink 时代 `<Static>` 保证每个时间线条目只渲染一次,markdown 渲染不缓存
 * 也没关系;OpenTUI 的 scrollbox 里条目随每次状态变化重渲染,长会话下
 * 每帧全量 markdown 解析会卡死——因此按 (key, width) 缓存定稿文本的
 * 渲染结果。条目定稿后文本不再变化,key 全局递增不复用,缓存天然安全;
 * 终端宽度变化会产生新键,旧宽度的条目按 LRU 逐出。
 */
const CACHE_MAX = 800;
const cache = new Map<string, string>();

export function renderMarkdownCached(key: string, text: string, columns: number): string {
  const cacheKey = `${key}@${columns}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) {
    // Map 迭代序即插入序;重插把它挪到"最新"端,实现 LRU。
    cache.delete(cacheKey);
    cache.set(cacheKey, hit);
    return hit;
  }
  const rendered = renderMarkdownAnsi(text, columns);
  cache.set(cacheKey, rendered);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return rendered;
}

/** 测试用:清空缓存。 */
export function clearMarkdownCache(): void {
  cache.clear();
}
