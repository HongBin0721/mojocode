/**
 * UI 测试公共 harness。
 *
 * 必须用 Bun 跑:`bun --bun x vitest run --config vitest.ui.config.ts`。
 * 原因见 vitest.ui.config.ts 头注释(原生 FFI 的运行时条件解析)。
 *
 * 两个上游行为已在 harness 内抹平,新测试不必再关心:
 * - React 19 的首次 commit 是异步的:render 后必须先让出事件循环再取帧,
 *   tick() 把「让出 + renderOnce」封装成一步;
 * - 状态更新会触发 act 警告:交互统一包在 act() 里。
 */
import { act } from 'react';
import type React from 'react';
import { testRender } from '@opentui/react/test-utils';
import { setTimeout as sleep } from 'node:timers/promises';

/** 去掉 ANSI(captureCharFrame 本身无 ANSI,此处兼容将来换 capture 方式)。 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

export interface UiHandle {
  /** 当前字符帧(每行右侧空白已裁剪)。 */
  frame(): string;
  /** 让出事件循环并渲染一帧;交互后调用它再断言。 */
  tick(): Promise<void>;
  /** 键入一段文本(逐字符 keypress)。 */
  type(text: string): Promise<void>;
  /** 按名字按键:'return' | 'escape' | 'tab' | 'up' | 'down' | 'left' | 'right' | 'backspace' | 单字符。 */
  press(name: string, mods?: { ctrl?: boolean; shift?: boolean; meta?: boolean }): Promise<void>;
  /** bracketed paste 粘贴一段文本。 */
  paste(text: string): Promise<void>;
  resize(width: number, height: number): void;
  destroy(): Promise<void>;
  /** 带样式的帧捕获(fg/bg/attributes 断言用)。 */
  spans(): ReturnType<Awaited<ReturnType<typeof testRender>>['captureSpans']>;
  renderer: Awaited<ReturnType<typeof testRender>>['renderer'];
  mockInput: Awaited<ReturnType<typeof testRender>>['mockInput'];
  mockMouse: Awaited<ReturnType<typeof testRender>>['mockMouse'];
}

export async function renderUi(
  node: React.ReactNode,
  options: { width?: number; height?: number } = {},
): Promise<UiHandle> {
  const setup = await testRender(node, {
    width: options.width ?? 100,
    height: options.height ?? 30,
  });
  const { renderer, mockInput, renderOnce, captureCharFrame } = setup;

  const tick = async (): Promise<void> => {
    await act(async () => {
      await sleep(0);
    });
    await renderOnce();
  };
  await tick();

  const withTick = async (fn: () => Promise<void> | void): Promise<void> => {
    await act(async () => {
      await fn();
      await sleep(0);
    });
    await renderOnce();
  };

  return {
    frame: () =>
      captureCharFrame()
        .replace(ANSI_RE, '')
        .split('\n')
        .map((line) => line.replace(/\s+$/, ''))
        .join('\n'),
    tick,
    type: (text) => withTick(() => mockInput.typeText(text)),
    press: (name, mods) =>
      withTick(async () => {
        if (name === 'return') mockInput.pressEnter(mods);
        else if (name === 'escape') {
          // 孤立 ESC 会被 stdin 解析器缓冲(等待可能的转义序列,还会污染
          // 下一个键),必须等超时冲刷。
          mockInput.pressEscape(mods);
          await sleep(60);
        } else if (name === 'tab') mockInput.pressTab(mods);
        else if (name === 'backspace') mockInput.pressBackspace(mods);
        else if (name === 'delete') mockInput.pressKey('DELETE', mods);
        else if (name === 'pageup') mockInput.pressKey('\x1b[5~', mods);
        else if (name === 'pagedown') mockInput.pressKey('\x1b[6~', mods);
        else if (name === 'up' || name === 'down' || name === 'left' || name === 'right')
          mockInput.pressArrow(name, mods);
        else mockInput.pressKey(name, mods);
      }),
    paste: (text) => withTick(() => mockInput.pasteBracketedText(text)),
    resize: (width, height) => setup.resize(width, height),
    spans: () => setup.captureSpans(),
    destroy: async () => {
      renderer.destroy();
      await sleep(0);
    },
    renderer,
    mockInput,
    mockMouse: setup.mockMouse,
  };
}
