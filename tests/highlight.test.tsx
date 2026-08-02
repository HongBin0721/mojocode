import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { highlightLine, languageFromPath, resolveLanguage } from '../src/ui/highlight.js';
import { Diff } from '../src/ui/Diff.js';
import { plain } from './support/ansi.js';

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

describe('Diff', () => {
  const patch = [
    '--- src/app.ts',
    '+++ src/app.ts',
    '@@ -10,3 +10,4 @@',
    ' const before = 1;',
    "-const dishes = ['a'];",
    "+const dishes = ['a', 'b'];",
    '',
  ].join('\n');

  it('渲染行号与 +/- 标记,且不丢失代码文本', () => {
    const { lastFrame, unmount } = render(<Diff patch={patch} />);
    const out = plain(lastFrame());
    expect(out).toContain('10');
    expect(out).toContain("- const dishes = ['a'];");
    expect(out).toContain("+ const dishes = ['a', 'b'];");
    // 文件头不出现在渲染结果里。
    expect(out).not.toContain('+++');
    unmount();
  });

  // hunk 内部以 ---/+++ 开头的是普通内容,不是文件头:当成文件头跳过会让
  // 改动从 diff 里凭空消失,而同一个组件也渲染写入/编辑的授权确认框。
  it('新增顶格的 ++ 内容行不会被当成文件头丢掉', () => {
    const p = ['--- src/main.cpp', '+++ src/main.cpp', '@@ -1,2 +1,3 @@', ' i = 0;', '+++i;', ' return i;'].join('\n');
    const { lastFrame, unmount } = render(<Diff patch={p} />);
    expect(plain(lastFrame())).toContain('+ ++i;');
    unmount();
  });

  it('删除顶格的 -- 内容行不会被丢掉,且旧文件行号继续推进', () => {
    const p = [
      '--- src/query.sql',
      '+++ src/query.sql',
      '@@ -1,3 +1,2 @@',
      ' select 1;',
      '--- legacy note',
      ' select 2;',
    ].join('\n');
    const out = plain(
      (() => {
        const { lastFrame, unmount } = render(<Diff patch={p} />);
        const frame = lastFrame();
        unmount();
        return frame;
      })(),
    );
    expect(out).toContain('- -- legacy note');
    // 删除行占掉旧文件的第 2 行,其后的上下文行仍是新文件的第 2 行。
    expect(out).toContain('2 - -- legacy note');
  });

  it('多个 hunk 之间插入折叠标记', () => {
    const multi = [
      '--- a.ts',
      '+++ a.ts',
      '@@ -1,1 +1,1 @@',
      '-let a = 1;',
      '@@ -20,1 +20,1 @@',
      '-let b = 2;',
    ].join('\n');
    const { lastFrame, unmount } = render(<Diff patch={multi} />);
    expect(plain(lastFrame())).toContain('⋯');
    unmount();
  });
});
