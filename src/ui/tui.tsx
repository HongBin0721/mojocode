import React from 'react';
import process from 'node:process';
import { render } from './kit.js';
import { App } from './App.js';
import { AuthWizard } from './AuthWizard.js';
import { SessionPicker } from './SessionPicker.js';
import { formatTranscript } from './transcript.js';
import type { Session } from '../app/bootstrap.js';
import type { TimelineItem } from './types.js';
import type { SessionMeta } from '../session/store.js';

/**
 * TUI 的动态 import 边界。cli.tsx 只能 `await import('./ui/tui.js')` 进来,
 * 不得静态引用本模块或其下游(kit → @opentui/core 在模块加载期就要拿原生
 * FFI):`-p` headless 与全部子命令必须在 Node 20 上照常工作,detect 与
 * import 的顺序见 src/app/runtime.ts。
 */

/** 主 TUI:渲染 App,退出后把时间线 dump 回主屏 scrollback。 */
export async function runTui(session: Session): Promise<void> {
  const itemsRef: { current: TimelineItem[] } = { current: [] };
  const instance = await render(<App session={session} itemsRef={itemsRef} />);
  await instance.waitUntilExit();
  // 此刻 alternate screen 已还原,stdout 回到主屏。
  if (itemsRef.current.length > 0) {
    process.stdout.write(formatTranscript(itemsRef.current, process.stdout.columns ?? 80));
  }
}

export async function runAuthWizard(): Promise<void> {
  const instance = await render(<AuthWizard />, { exitOnCtrlC: true });
  await instance.waitUntilExit();
}

/** 启动期会话选择器;esc/ctrl+c 返回 undefined(开新会话)。 */
export async function runSessionPicker(sessions: SessionMeta[]): Promise<string | undefined> {
  let picked: string | undefined;
  const instance = await render(
    <SessionPicker
      sessions={sessions}
      onSelect={(id) => {
        picked = id;
      }}
    />,
    { exitOnCtrlC: true },
  );
  await instance.waitUntilExit();
  return picked;
}
