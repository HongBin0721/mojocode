/**
 * 项目列表纯函数测试:localStorage 原始值解析的健壮性(坏 JSON/异构数组)
 * 与增删语义(去重、保持顺序、幂等移除)。
 */

import { describe, expect, it } from 'vitest';
import { addProject, loadProjects, removeProject } from '../src/renderer/utils/projects.js';

describe('projects 列表', () => {
  it('解析:null/坏 JSON/非数组一律回空', () => {
    expect(loadProjects(null)).toEqual([]);
    expect(loadProjects('oops')).toEqual([]);
    expect(loadProjects('{"a":1}')).toEqual([]);
  });

  it('解析:过滤非字符串与空串,保留合法路径', () => {
    expect(loadProjects('["/a/b", 42, "", "/c"]')).toEqual(['/a/b', '/c']);
  });

  it('添加:去重且新项排尾', () => {
    const list = addProject(['/a'], '/b');
    expect(list).toEqual(['/a', '/b']);
    expect(addProject(list, '/a')).toBe(list); // 已存在原样返回
  });

  it('移除:命中删除,未命中原引用返回(调用方据此跳过落盘)', () => {
    expect(removeProject(['/a', '/b'], '/a')).toEqual(['/b']);
    const list = ['/a'];
    expect(removeProject(list, '/x')).toBe(list);
  });
});
