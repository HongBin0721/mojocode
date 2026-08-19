/**
 * 斜杠命令表与输入态解析的纯函数测试。
 */

import { describe, expect, it } from 'vitest';
import { setLocale } from '../src/renderer/i18n/index.js';
import {
  builtinCommands,
  filterCommands,
  slashState,
  skillCommands,
} from '../src/renderer/commands/index.js';

setLocale('zh-CN');

describe('slashState', () => {
  it('非 / 开头不激活', () => {
    expect(slashState('你好')).toEqual({ active: false, query: '' });
    expect(slashState('')).toEqual({ active: false, query: '' });
  });
  it('/ 激活,query 为斜杠后片段;出现空格进入参数态(菜单收起)', () => {
    expect(slashState('/')).toEqual({ active: true, query: '' });
    expect(slashState('/rev')).toEqual({ active: true, query: 'rev' });
    expect(slashState('/review ')).toEqual({ active: false, query: 'review' });
    expect(slashState('/review base main')).toEqual({ active: false, query: 'review' });
  });
});

describe('命令表', () => {
  it('内置五命令 + 技能直映射', () => {
    expect(builtinCommands().map((e) => e.name)).toEqual(['models', 'new', 'compact', 'review', 'simplify']);
    const skills = skillCommands([
      { name: 'release', description: '发布流程', argumentHint: '[version]' },
      { name: 'lint', description: '跑 lint' },
    ]);
    expect(skills).toEqual([
      { name: 'release', description: '发布流程', argumentHint: '[version]', source: 'skill' },
      { name: 'lint', description: '跑 lint', source: 'skill' },
    ]);
  });

  it('前缀过滤,大小写不敏感;空 query 返回全表', () => {
    const all = [...builtinCommands(), ...skillCommands([{ name: 'release', description: '发布' }])];
    expect(filterCommands(all, '')).toHaveLength(6);
    expect(filterCommands(all, 're').map((e) => e.name)).toEqual(['review', 'release']);
    expect(filterCommands(all, 'RE')).toHaveLength(2);
  });
});
