import { afterEach, describe, expect, it } from 'vitest';
import { clearMarkdownCache, renderMarkdownCached } from '../src/ui/md-cache.js';
import { renderMarkdownAnsi } from '../src/ui/markdown-ansi.js';

afterEach(() => clearMarkdownCache());

describe('md-cache', () => {
  it('同键同宽命中缓存(结果与直渲一致)', () => {
    const text = '# 标题\n\n正文 **加粗**';
    const direct = renderMarkdownAnsi(text, 60);
    expect(renderMarkdownCached('item-1', text, 60)).toBe(direct);
    // 第二次命中缓存,仍然一致
    expect(renderMarkdownCached('item-1', text, 60)).toBe(direct);
  });

  it('宽度不同是不同缓存键', () => {
    const text = '一段会因宽度不同而折行位置不同的比较长的中文文本,足以超过窄终端宽度。';
    const narrow = renderMarkdownCached('item-2', text, 20);
    const wide = renderMarkdownCached('item-2', text, 80);
    expect(narrow).not.toBe(wide);
    expect(narrow).toBe(renderMarkdownAnsi(text, 20));
  });
});
