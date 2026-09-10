/**
 * Pi 形状的工具定义 → AI SDK Tool 的适配(`api.registerTool(definition)`)。
 *
 * 只适配**能一一对应**的部分:JSON Schema 参数(TypeBox 的 schema 本身就是
 * JSON Schema)经 `jsonSchema()` 进 SDK;`execute(toolCallId, params, signal,
 * onUpdate, ctx)` 原签名调用;返回值若是 Pi 的 AgentToolResult
 * (`{ content: [{ type: 'text', text }…], details }`)就把文本拼成字符串喂回
 * 模型——SDK 会把对象整个 JSON 化,而 Pi 的 content 数组对模型只是噪音;
 * 其他形状原样返回。`onUpdate` 的增量以 `tool-output-delta` 上总线,前端与
 * bash 的流式输出同一条路呈现。`renderCall` / `renderResult` 没有对应物,忽略。
 */

import { jsonSchema, tool, type Tool } from 'ai';
import type { EventBus } from '../core/events.js';
import type {
  ExtensionContext,
  ExtensionToolDefinition,
  ExtensionToolFactory,
} from '../core/extension.js';

interface PiToolResultLike {
  content?: Array<{ type?: string; text?: string }>;
}

/** Pi 的 AgentToolResult → 喂给模型的输出。 */
export function flattenPiResult(result: unknown): unknown {
  if (!result || typeof result !== 'object' || !Array.isArray((result as PiToolResultLike).content)) {
    return result;
  }
  const parts = (result as PiToolResultLike).content!;
  return parts
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

export function adaptToolDefinition(
  definition: ExtensionToolDefinition,
  deps: { bus: EventBus; ctx: () => ExtensionContext },
): ExtensionToolFactory {
  const built: Tool = tool({
    description: definition.description,
    inputSchema: jsonSchema(definition.parameters as never),
    execute: async (input, options) => {
      const onUpdate = (partial: unknown): void => {
        const text = typeof partial === 'string' ? partial : flattenPiResult(partial);
        if (typeof text === 'string' && text) {
          deps.bus.emit({ type: 'tool-output-delta', callId: options.toolCallId, chunk: text });
        }
      };
      const result = await definition.execute(
        options.toolCallId,
        input,
        options.abortSignal,
        onUpdate,
        deps.ctx(),
      );
      return flattenPiResult(result);
    },
  });
  return (scope) => (definition.scope ? (definition.scope(scope) ? built : undefined) : built);
}
