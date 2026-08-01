import { jsonSchema, tool, type ToolSet } from 'ai';
import type { McpConnection } from './client.js';
import type { PermissionGate } from '../permissions/gate.js';
import { truncate } from '../tools/context.js';

/**
 * Converts MCP tools into AI SDK tools.
 *
 * Deliberately hand-rolled rather than using AI SDK's experimental MCP client:
 * this way the permission gate sits in front of every call, and an AI SDK
 * upgrade cannot silently change how MCP tools behave.
 */
export function bridgeMcpTools(connections: McpConnection[], gate: PermissionGate): ToolSet {
  const tools: ToolSet = {};
  const taken = new Set<string>();

  for (const connection of connections) {
    for (const mcpTool of connection.tools) {
      // Namespace so two servers exposing `search` don't collide.
      let name = `mcp__${connection.name}__${mcpTool.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
      if (taken.has(name)) name = `${name}_${taken.size}`;
      taken.add(name);

      tools[name] = tool({
        description: mcpTool.description ?? `Tool "${mcpTool.name}" from MCP server "${connection.name}".`,
        // MCP hands us raw JSON Schema; jsonSchema() passes it through without
        // a zod round-trip that would lose constraints.
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

/** MCP content is a list of typed blocks; flatten to text the model can read. */
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
