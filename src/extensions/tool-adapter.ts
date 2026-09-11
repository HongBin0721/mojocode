/**
 * Pi 形状的工具定义 → AI SDK Tool 的适配(`api.registerTool(definition)`)。
 *
 * 只适配**能一一对应**的部分:JSON Schema 参数(TypeBox 的 schema 本身就是
 * JSON Schema)经 `jsonSchema()` 进 SDK;`execute(toolCallId, params, signal,
 * onUpdate, ctx)` 原签名调用。返回值若是 Pi 的 AgentToolResult
 * (`{ content: [{ type: 'text', text }…], details }`)**原样保留**作为工具输出
 * ——`renderResult` 与 `tool_result` 钩子看到的就是它,`details` 是 Pi 留给
 * 画法的通道;喂给模型的那份由 SDK 的 `toModelOutput` 分流成 content 拼成
 * 的文本(SDK 缺省会把对象整个 JSON 化,content 数组对模型只是噪音)。
 * 历史里落盘的也是 toModelOutput 的文本,details 不进持久历史。其他形状
 * 原样返回。`onUpdate` 的增量以 `tool-output-delta` 上总线,前端与 bash 的
 * 流式输出同一条路呈现。`renderCall` / `renderResult` 由 bootstrap 登记进
 * `toolRenderers`,不经这里。
 */

import { jsonSchema, tool, type Tool } from 'ai';
import type { EventBus } from '../core/events.js';
import type {
  ExtensionContext,
  ExtensionToolDefinition,
  ExtensionToolFactory,
} from '../core/extension.js';
import { flattenPiResult, isPiToolResult } from '../core/extension-types.js';

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
      return definition.execute(options.toolCallId, input, options.abortSignal, onUpdate, deps.ctx());
    },
    // Pi 结果:模型只看 content 拼成的文本,details 留在工具输出里给画法。
    // 其余形状要**逐字复刻 SDK 的缺省**(createToolModelOutput):我们给了
    // toModelOutput,SDK 就不再走它自己那条路,而那条路上的 toJSONValue 把
    // `undefined` 换成 `null`。Pi 的 execute 允许什么都不返回,漏掉这一步的话
    // tool 消息带着 content: undefined 发出去,请求直接 400。
    toModelOutput: ({ output }) => {
      if (isPiToolResult(output)) return { type: 'text', value: String(flattenPiResult(output)) };
      if (typeof output === 'string') return { type: 'text', value: output };
      return { type: 'json', value: (output === undefined ? null : output) as never };
    },
  });
  return (scope) => (definition.scope ? (definition.scope(scope) ? built : undefined) : built);
}
