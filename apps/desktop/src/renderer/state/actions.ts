/**
 * renderer 侧的共享动作:把「守卫 + RPC + 错误处理」收拢成一份,组件只做
 * 接线。此前 newSession 的 running 守卫在 CollapsedOverlay / Sidebar / ⌘N
 * 三处各抄一遍,谁漏了守卫谁就能在运行中开新会话。
 */

import { useDesktopStore } from './desktopStore.js';

/** 新建会话(running 时静默忽略——与 sidebar.busy 的提示语义一致)。 */
export function newSession(): void {
  if (useDesktopStore.getState().snapshot?.agent.isRunning) return;
  void window.mojocode.rpc({ kind: 'newSession' }).catch((error: unknown) => {
    console.error('newSession 失败', error);
  });
}
