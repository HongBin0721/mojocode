import { connectMcpServers, type McpStatus } from '../../mcp/client.js';
import type { Config } from '../../config/schema.js';
import { t } from '../../i18n/index.js';
import type { DoctorCheck } from './types.js';

export async function mcpChecks(
  config: Config,
  offline: boolean,
  known?: McpStatus[],
): Promise<DoctorCheck[]> {
  const entries = Object.entries(config.mcpServers);
  if (entries.length === 0) {
    return [{ id: 'mcpNone', label: t('doctor.check.mcp'), level: 'info', detail: t('doctor.mcpNone') }];
  }

  const describe = (config_: (typeof entries)[number][1]): string =>
    config_.type === 'stdio' ? `stdio · ${config_.command}` : `http · ${config_.url}`;

  if (offline && !known) {
    return entries.map(([name, server]) => ({
      id: `mcp:${name}`,
      label: name,
      level: 'info' as const,
      detail: `${describe(server)} · ${t('doctor.skippedOffline')}`,
    }));
  }

  let statuses: McpStatus[];
  if (known) {
    statuses = known;
  } else {
    const enabled = entries.filter(([, server]) => server.enabled !== false);
    const result = await connectMcpServers(Object.fromEntries(enabled));
    // 探测完必须断开:stdio server 是子进程,留着会让 doctor 退不出去。
    await Promise.all(result.connections.map((c) => c.close().catch(() => undefined)));
    statuses = result.statuses;
  }

  return entries.map(([name, server]) => {
    if (server.enabled === false) {
      return {
        id: `mcp:${name}`,
        label: name,
        level: 'info' as const,
        detail: `${describe(server)} · ${t('doctor.mcpDisabled')}`,
      };
    }
    const status = statuses.find((s) => s.name === name);
    if (status?.connected) {
      return {
        id: `mcp:${name}`,
        label: name,
        level: 'ok' as const,
        detail: `${describe(server)} · ${t('doctor.mcpTools', { n: String(status.toolCount) })}`,
      };
    }
    return {
      id: `mcp:${name}`,
      label: name,
      level: 'fail' as const,
      detail: `${describe(server)} · ${status?.error ?? '?'}`,
      hint: t('doctor.mcpFailHint'),
    };
  });
}
