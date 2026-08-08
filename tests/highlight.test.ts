import { describe, expect, it } from 'vitest';
import {
  highlightDiffLine,
  highlightLine,
  languageFromPath,
  resolveLanguage,
} from '../src/ui/highlight.js';
import { parseAnsiSpans } from '../src/ui/ansi-spans.js';
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

describe('highlightDiffLine', () => {
  /** 一行高亮结果里出现过的所有前景色(经 ansi-spans 归一成十六进制)。 */
  const colorsOf = (line: string, language: string): string[] =>
    parseAnsiSpans(highlightDiffLine(line, language))
      .map((span) => span.fg)
      .filter((fg): fg is string => Boolean(fg));

  /** sRGB 相对亮度,用来判断"够不够亮到能画在深色底上"。 */
  const luminance = (hex: string): number => {
    const channel = (v: number): number => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const r = channel(Number.parseInt(hex.slice(1, 3), 16));
    const g = channel(Number.parseInt(hex.slice(3, 5), 16));
    const b = channel(Number.parseInt(hex.slice(5, 7), 16));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  it('着色不改变可见文本', () => {
    const line = 'def greet(name):  # 打招呼';
    expect(plain(highlightDiffLine(line, 'python'))).toBe(line);
  });

  it('没有语言时原样返回,语法不完整也不抛', () => {
    expect(highlightDiffLine('print("hi")', undefined)).toBe('print("hi")');
    expect(() => highlightDiffLine('const x = `未闭合', 'typescript')).not.toThrow();
  });

  // 这是实际踩到的 bug:highlight.js 的默认终端主题给字符串上红色,
  // 画在新增行的深绿底上就是"绿底红字",语义正好反过来。
  it('新增行里的字符串不再是红色', () => {
    const colors = colorsOf('    print("goodbye " + name)', 'python');
    expect(colors.length).toBeGreaterThan(0);
    expect(colors).not.toContain('#cd3131');
  });

  it('全部前景色都避开红/绿,且够亮(diff 底色是我们指定的深色)', () => {
    const samples: Array<[string, string]> = [
      ['def greet(name):  # 注释', 'python'],
      ['const n = 42; // 注释', 'javascript'],
      ['export type A = { s: string };', 'typescript'],
      ['echo "hi" # 注释', 'bash'],
      ['key = "value" ; 注释', 'ini'],
    ];
    for (const [line, language] of samples) {
      for (const color of colorsOf(line, language)) {
        const r = Number.parseInt(color.slice(1, 3), 16);
        const g = Number.parseInt(color.slice(3, 5), 16);
        const b = Number.parseInt(color.slice(5, 7), 16);
        // 红或绿"独大"的色都不能用:它们是 diff 自己的语义。
        expect(r - Math.max(g, b), `${color} 偏红 (${line})`).toBeLessThan(60);
        expect(g - Math.max(r, b), `${color} 偏绿 (${line})`).toBeLessThan(60);
        // 深色底上要读得出来
        expect(luminance(color), `${color} 太暗 (${line})`).toBeGreaterThan(0.15);
      }
    }
  });
});
