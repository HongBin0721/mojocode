import { describe, expect, it } from 'vitest';
import { highlightLine, languageFromPath, resolveLanguage } from '../src/ui/highlight.js';
import { plain } from './support/ansi.js';

/**
 * highlight 的纯函数部分(无渲染),Node 测试道跑。
 * Diff 组件的渲染测试在 tests/ui/diff-markdown.test.tsx(OpenTUI/Bun 道)。
 */

describe('languageFromPath', () => {
  it('按扩展名识别,含别名归一化', () => {
    expect(languageFromPath('src/ui/App.tsx')).toBe('typescript');
    expect(languageFromPath('src/cli.mjs')).toBe('javascript');
    expect(languageFromPath('/abs/path/main.py')).toBe('python');
    expect(languageFromPath('scripts\\deploy.sh')).toBe('bash');
    // highlight.js 没有 toml,退到规则最接近的 ini。
    expect(languageFromPath('Cargo.toml')).toBe('ini');
  });

  it('按文件名识别没有扩展名的常见文件', () => {
    expect(languageFromPath('Dockerfile')).toBe('dockerfile');
    expect(languageFromPath('build/Makefile')).toBe('makefile');
  });

  it('认不出的一律返回 undefined', () => {
    expect(languageFromPath('LICENSE')).toBeUndefined();
    expect(languageFromPath('data.bin')).toBeUndefined();
    expect(languageFromPath('')).toBeUndefined();
  });
});

describe('resolveLanguage', () => {
  it('大小写不敏感,不支持的返回 undefined', () => {
    expect(resolveLanguage('TS')).toBe('typescript');
    expect(resolveLanguage('python')).toBe('python');
    expect(resolveLanguage('nonesuch')).toBeUndefined();
  });
});

describe('highlightLine', () => {
  it('没有语言时原样返回', () => {
    expect(highlightLine('const a = 1;', undefined)).toBe('const a = 1;');
  });

  it('着色不改变可见文本', () => {
    const line = "const dishes = ['麻辣烫', '兰州拉面'];";
    expect(plain(highlightLine(line, 'javascript'))).toBe(line);
  });

  it('语法不完整的片段不抛异常', () => {
    expect(() =>
      highlightLine('function hi(name: string) { // 截断在这', 'typescript'),
    ).not.toThrow();
  });
});
