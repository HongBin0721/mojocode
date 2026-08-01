import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from '../config/schema.js';
import { APP_NAME } from '../config/paths.js';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface McpConnection {
  name: string;
  client: Client;
  tools: McpTool[];
  close: () => Promise<void>;
}

export interface McpStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

const CONNECT_TIMEOUT_MS = 15_000;

async function connectOne(name: string, config: McpServerConfig): Promise<McpConnection> {
  const client = new Client(
    { name: APP_NAME, version: '0.1.0' },
    { capabilities: {} },
  );

  const transport =
    config.type === 'stdio'
      ? new StdioClientTransport({
          command: config.command,
          args: config.args,
          cwd: config.cwd,
          env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
        })
      : new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers },
        });

  await withTimeout(
    client.connect(transport),
    CONNECT_TIMEOUT_MS,
    `MCP server "${name}" did not respond within ${CONNECT_TIMEOUT_MS}ms`,
  );

  const { tools } = await client.listTools();

  return {
    name,
    client,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

/**
 * 连接所有已启用的 server。某个 server 启动失败不能中断会话——其错误
 * 会显示在 `/mcp` 中,其余 server 照常工作。
 */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  onStatus?: (status: McpStatus) => void,
): Promise<{ connections: McpConnection[]; statuses: McpStatus[] }> {
  const entries = Object.entries(servers).filter(([, config]) => config.enabled !== false);

  const results = await Promise.all(
    entries.map(async ([name, config]): Promise<{ connection?: McpConnection; status: McpStatus }> => {
      try {
        const connection = await connectOne(name, config);
        const status: McpStatus = { name, connected: true, toolCount: connection.tools.length };
        onStatus?.(status);
        return { connection, status };
      } catch (err) {
        const status: McpStatus = {
          name,
          connected: false,
          toolCount: 0,
          error: err instanceof Error ? err.message : String(err),
        };
        onStatus?.(status);
        return { status };
      }
    }),
  );

  return {
    connections: results.flatMap((r) => (r.connection ? [r.connection] : [])),
    statuses: results.map((r) => r.status),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
