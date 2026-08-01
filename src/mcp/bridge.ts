import { jsonSchema, tool, type ToolSet } from 'ai';
import type { McpConnection } from './client.js';
import type { PermissionGate } from '../permissions/gate.js';
import { truncate } from '../tools/context.js';

/**
 * 把 MCP 工具转换成 AI SDK 工具。
 *
 * 有意手写而不用 AI SDK 的实验性 MCP client:这样权限门禁能挡在每次调用
 * 前面,AI SDK 升级也不会悄悄改变 MCP 工具的行为。
 */
export function bridgeMcpTools(connections: McpConnection[], gate: PermissionGate): ToolSet {
  const tools: ToolSet = {};
  const taken = new Set<string>();

  for (const connection of connections) {
    for (const mcpTool of connection.tools) {
      // 加命名空间,避免两个 server 都暴露 `search` 时发生冲突。
      let name = `mcp__${connection.name}__${mcpTool.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
      if (taken.has(name)) name = `${name}_${taken.size}`;
      taken.add(name);

      tools[name] = tool({
        description: mcpTool.description ?? `Tool "${mcpTool.name}" from MCP server "${connection.name}".`,
        // MCP 给的是原始 JSON Schema;jsonSchema() 直接透传,避免经过
        // zod 往返转换而丢失约束。
        inputSchema: jsonSchema(mcpTool.inputSchema as Record<string, unknown>),
        execute: async (input) => {
          await gate.checkMcpTool(name, input);

          const result = await connection.client.callTool({
            name: mcpTool.name,
            arguments: (input ?? {}) as Record<string, unknown>,
          });

          const text = renderContent(result.content);
          if (result.isError) {
            throw new Error(text || `MCP tool ${mcpTool.name} reported an error.`);
          }
          return { content: truncate(text) };
        },
      });
    }
  }

  return tools;
}

/** MCP 的 content 是一组带类型的块;压平成模型可读的文本。 */
function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';

  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return '';
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      if (b.type === 'resource' && typeof b.resource === 'object' && b.resource !== null) {
        const resource = b.resource as Record<string, unknown>;
        return typeof resource.text === 'string' ? resource.text : `[resource ${String(resource.uri)}]`;
      }
      if (b.type === 'image') return '[image omitted]';
      return `[${String(b.type ?? 'unknown')} content]`;
    })
    .filter(Boolean)
    .join('\n');
}
