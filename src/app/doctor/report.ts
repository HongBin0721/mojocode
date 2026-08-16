import process from 'node:process';
import { ConfigError, loadRawConfig } from '../../config/load.js';
import { sessionsDir as defaultSessionsDir } from '../../config/paths.js';
import { packageVersion } from '../../config/version.js';
import { t } from '../../i18n/index.js';
import type { DoctorInput, DoctorOptions, DoctorReport, DoctorSection } from './types.js';
import { envChecks } from './env.js';
import { configChecks, permissionChecks } from './config.js';
import { providerChecks } from './provider.js';
import { searchChecks } from './search.js';
import { lspChecks } from './lsp.js';
import { mcpChecks } from './mcp.js';
import { sessionChecks } from './sessions.js';
import { workspaceChecks } from './workspace.js';
import { skillsChecks } from './skills.js';

/** CLI 入口:先做分层加载(允许失败),再交给 collectDoctor 体检。 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  let input: DoctorInput;
  try {
    const { config, sources, warnings } = await loadRawConfig({ root: options.root, env });
    input = { ...options, env, config: options.config ?? config, sources, warnings };
  } catch (error) {
    // 配置坏了恰恰是最该跑 doctor 的时候:照常出报告,把解析错误当成一条失败项。
    input = {
      ...options,
      env,
      sources: [],
      warnings: [],
      configError: error instanceof ConfigError || error instanceof Error ? error.message : String(error),
    };
  }
  return collectDoctor(input);
}

export async function collectDoctor(input: DoctorInput): Promise<DoctorReport> {
  const env = input.env ?? process.env;
  const offline = input.offline === true;
  const version = input.version ?? packageVersion();
  const config = input.config;

  // 各分节并发跑,再按固定顺序组装。三项联网检查(registry 8s、端点 8s、
  // MCP 15s)串起来就是半分钟起步的干等,而它们之间毫无依赖。
  const [envC, configC, providerC, searchC, lspC, mcpC, sessionsC, workspaceC, skillsC] = await Promise.all([
    envChecks({ version, offline, fetchImpl: input.fetchImpl }),
    configChecks(input),
    config ? providerChecks(config, env, offline, input.fetchImpl) : undefined,
    config ? searchChecks(config, env, offline, input.fetchImpl) : undefined,
    config ? lspChecks(config, env, input.root, offline, input.lspStatuses) : undefined,
    config ? mcpChecks(config, offline, input.mcpStatuses) : undefined,
    sessionChecks(input.sessionsDir ?? defaultSessionsDir(), config),
    workspaceChecks(input.root),
    skillsChecks(input.root),
  ]);

  const sections: DoctorSection[] = [
    { id: 'env', title: t('doctor.section.env'), checks: envC },
    { id: 'config', title: t('doctor.section.config'), checks: configC },
  ];
  if (config && providerC && searchC && lspC && mcpC) {
    sections.push(
      { id: 'provider', title: t('doctor.section.provider'), checks: providerC },
      { id: 'search', title: t('doctor.section.search'), checks: searchC },
      { id: 'lsp', title: t('doctor.section.lsp'), checks: lspC },
      { id: 'permissions', title: t('doctor.section.permissions'), checks: permissionChecks(config) },
      { id: 'mcp', title: t('doctor.section.mcp'), checks: mcpC },
    );
  }
  sections.push(
    { id: 'sessions', title: t('doctor.section.sessions'), checks: sessionsC },
    { id: 'workspace', title: t('doctor.section.workspace'), checks: workspaceC },
    { id: 'skills', title: t('doctor.section.skills'), checks: skillsC },
  );

  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const section of sections) {
    for (const check of section.checks) {
      if (check.level !== 'info') counts[check.level] += 1;
    }
  }

  return { version, sections, counts, healthy: counts.fail === 0 };
}
