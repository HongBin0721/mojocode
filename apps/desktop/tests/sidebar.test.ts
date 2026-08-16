// @vitest-environment jsdom
/**
 * 侧栏几何纯函数测试:宽度钳制(264 下限/50vw 上限/非法值回默认)与
 * localStorage 持久化往返。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  SIDEBAR_DEFAULT_WIDTH,
  clampSidebarWidth,
  loadSidebarCollapsed,
  loadSidebarWidth,
  saveSidebarCollapsed,
  saveSidebarWidth,
} from '../src/renderer/utils/sidebar.js';

describe('sidebar geometry', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('钳制:低于 264 抬回 264,高于 50vw 压回 50vw', () => {
    expect(clampSidebarWidth(100, 1200)).toBe(264);
    expect(clampSidebarWidth(300, 1200)).toBe(300);
    expect(clampSidebarWidth(900, 1200)).toBe(600);
    // 窄窗时上限退到默认值,不许负空间。
    expect(clampSidebarWidth(400, 400)).toBe(264);
  });

  it('非法输入:NaN 回默认,+Infinity 钳到上限', () => {
    expect(clampSidebarWidth(Number.NaN, 1200)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY, 1200)).toBe(600);
    expect(clampSidebarWidth(Number.NEGATIVE_INFINITY, 1200)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('持久化往返:宽度与折叠态', () => {
    saveSidebarWidth(320);
    expect(loadSidebarWidth(1200)).toBe(320);
    saveSidebarCollapsed(true);
    expect(loadSidebarCollapsed()).toBe(true);
    saveSidebarCollapsed(false);
    expect(loadSidebarCollapsed()).toBe(false);
  });

  it('越界持久化值读回时重新钳制', () => {
    localStorage.setItem('mojocode.sidebar-width', '5000');
    expect(loadSidebarWidth(1200)).toBe(600);
    localStorage.setItem('mojocode.sidebar-width', 'oops');
    expect(loadSidebarWidth(1200)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});
