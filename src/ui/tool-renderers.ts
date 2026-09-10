/**
 * 工具的自定义画法(扩展 registerTool 的 renderCall / renderResult)在 TUI 里
 * 的读口。时间线条目是 <For> 复用的独立组件,不从 App 的 props 一层层传
 * 下去;App 在 extensionsChanged 时把 session.toolRenderers 灌进这份信号,
 * ToolEntry 按工具名读。
 */

import { createSignal } from 'solid-js';
import type { MessageRenderer, ToolRenderers } from '../core/extension-types.js';

const [renderers, setRenderers] = createSignal<ReadonlyMap<string, ToolRenderers>>(new Map());
const [messageRenderers, setMessageRenderersSignal] = createSignal<ReadonlyMap<string, MessageRenderer>>(
  new Map(),
);

export function setToolRenderers(next: ReadonlyMap<string, ToolRenderers>): void {
  setRenderers(next);
}

export function toolRendererFor(toolName: string): ToolRenderers | undefined {
  return renderers().get(toolName);
}

/** 自定义消息的画法(registerMessageRenderer)同款读口。 */
export function setMessageRenderers(next: ReadonlyMap<string, MessageRenderer>): void {
  setMessageRenderersSignal(next);
}

export function messageRendererFor(customType: string): MessageRenderer | undefined {
  return messageRenderers().get(customType);
}
