import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import stringWidth from 'string-width';
import { ConfigError, loadRawConfig, resolveProvider, type ResolvedProvider } from '../config/load.js';
import {
  APP_NAME,
  globalConfigPath,
  projectConfigPath,
  sessionsDir as defaultSessionsDir,
} from '../config/paths.js';
import { PROVIDER_PRESETS, isBuiltinProvider } from '../config/providers.js';
import { permissionsLabel, type Config } from '../config/schema.js';
import { packageRoot, packageVersion } from '../config/version.js';
import { connectMcpServers, type McpStatus } from '../mcp/client.js';
import { probeModels } from '../model/registry.js';
import { t } from '../i18n/index.js';

/** 每一项检查的结论。`info` 是纯陈述,不计入通过/告警/失败的汇总。 */
export type CheckLevel = 'ok' | 'warn' | 'fail' | 'info';

export interface DoctorCheck {
  /** 稳定标识:--json 的消费方和测试认它,不认本地化后的 label。 */
  id: string;
  label: string;
  level: CheckLevel;
  detail?: string;
  /** 修复建议,只在 warn/fail 时给。 */
  hint?: string;
}

export interface DoctorSection {
  id: string;
  title: string;
  checks: DoctorCheck[];
}

export interface DoctorReport {
  version: string;
  sections: DoctorSection[];
  counts: { ok: number; warn: number; fail: number };
  /** 没有 fail 即为健康;warn 不影响可用性。 */
  healthy: boolean;
}

/** 联网检查的最长等待。诊断命令必须能在十几秒内给出结论,不能吊着不动。 */
const NETWORK_TIMEOUT_MS = 8_000;
const NODE_MIN_MAJOR = 20;
const REGISTRY_URL = `https://registry.npmjs.org/${APP_NAME}/latest`;

export interface DoctorInput {
  root: string;
  /** 分层加载后的配置;加载失败时给 undefined,并在 configError 里说明。 */
  config?: Config;
  configError?: string;
  /** 实际生效的配置文件路径,按优先级排序。 */
  sources: string[];
  /** 加载期提示(旧版 permissionMode 的一次性转换等)。 */
  warnings: string[];
  env?: NodeJS.ProcessEnv;
  /** 跳过全部联网检查(端点探测、版本比对、MCP 连接)。 */
  offline?: boolean;
  /** 覆盖会话目录(测试用)。 */
  sessionsDir?: string;
  /** 覆盖配置文件路径(测试用);不传则用 ~/.mojocode 与 <root>/.mojocode。 */
  globalConfigFile?: string;
  projectConfigFile?: string;
  fetchImpl?: typeof fetch;
  version?: string;
  /**
   * 已知的 MCP 连接状态。给了就直接采信,不再自己连一遍——TUI 里 server
   * 已经连着,再连一次等于把每个 stdio server 的子进程又拉起一份。
   */
  mcpStatuses?: McpStatus[];
}

export interface DoctorOptions {
  root: string;
  env?: NodeJS.ProcessEnv;
  offline?: boolean;
  fetchImpl?: typeof fetch;
  /**
   * 会话当前生效的配置。TUI 传它,好让报告反映 /approvals、/model 这些
   * 运行期改动;不传则以磁盘上的分层结果为准(CLI 的情形)。
   */
  config?: Config;
  mcpStatuses?: McpStatus[];
}

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
  const [envC, configC, providerC, mcpC, sessionsC, workspaceC] = await Promise.all([
    envChecks({ version, offline, fetchImpl: input.fetchImpl }),
    configChecks(input),
    config ? providerChecks(config, env, offline, input.fetchImpl) : undefined,
    config ? mcpChecks(config, offline, input.mcpStatuses) : undefined,
    sessionChecks(input.sessionsDir ?? defaultSessionsDir(), config),
    workspaceChecks(input.root),
  ]);

  const sections: DoctorSection[] = [
    { id: 'env', title: t('doctor.section.env'), checks: envC },
    { id: 'config', title: t('doctor.section.config'), checks: configC },
  ];
  if (config && providerC && mcpC) {
    sections.push(
      { id: 'provider', title: t('doctor.section.provider'), checks: providerC },
      { id: 'permissions', title: t('doctor.section.permissions'), checks: permissionChecks(config) },
      { id: 'mcp', title: t('doctor.section.mcp'), checks: mcpC },
    );
  }
  sections.push(
    { id: 'sessions', title: t('doctor.section.sessions'), checks: sessionsC },
    { id: 'workspace', title: t('doctor.section.workspace'), checks: workspaceC },
  );

  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const section of sections) {
    for (const check of section.checks) {
      if (check.level !== 'info') counts[check.level] += 1;
    }
  }

  return { version, sections, counts, healthy: counts.fail === 0 };
}

async function envChecks(opts: {
  version: string;
  offline: boolean;
  fetchImpl?: typeof fetch;
}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  const latest = opts.offline ? undefined : await latestVersion(opts.fetchImpl);
  const outdated = latest !== undefined && compareVersions(latest, opts.version) > 0;
  checks.push({
    id: 'version',
    label: t('doctor.check.version'),
    level: outdated ? 'warn' : 'ok',
    detail:
      opts.version +
      (opts.offline
        ? ''
        : latest === undefined
          ? ` · ${t('doctor.latestUnknown')}`
          : outdated
            ? ` · ${t('doctor.updateAvailable', { latest })}`
            : ` · ${t('doctor.upToDate')}`),
    ...(outdated ? { hint: t('doctor.updateHint', { name: APP_NAME }) } : {}),
  });

  const major = Number(process.versions.node.split('.')[0]);
  const tooOld = Number.isFinite(major) && major < NODE_MIN_MAJOR;
  checks.push({
    id: 'node',
    label: t('doctor.check.node'),
    level: tooOld ? 'fail' : 'ok',
    detail: `v${process.versions.node}`,
    ...(tooOld ? { hint: t('doctor.nodeTooOld', { required: String(NODE_MIN_MAJOR) }) } : {}),
  });

  checks.push({
    id: 'platform',
    label: t('doctor.check.platform'),
    level: 'info',
    detail: `${process.platform} ${process.arch} · ${os.release()} · TERM=${process.env.TERM ?? '?'}`,
  });

  checks.push({
    id: 'install',
    label: t('doctor.check.install'),
    level: 'info',
    detail: packageRoot(),
  });

  return checks;
}

async function configChecks(input: DoctorInput): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const globalFile = input.globalConfigFile ?? globalConfigPath();
  const projectFile = input.projectConfigFile ?? projectConfigPath(input.root);

  for (const [id, file] of [
    ['configGlobal', globalFile],
    ['configProject', projectFile],
  ] as const) {
    const exists = await fileExists(file);
    checks.push({
      id,
      label: t(id === 'configGlobal' ? 'doctor.check.configGlobal' : 'doctor.check.configProject'),
      level: 'info',
      detail: `${file}${exists ? '' : ` · ${t('doctor.notPresent')}`}`,
    });
  }

  if (input.configError) {
    checks.push({
      id: 'configLoad',
      label: t('doctor.check.configLoad'),
      level: 'fail',
      detail: input.configError,
      hint: t('doctor.configLoadHint'),
    });
    return checks;
  }

  checks.push({
    id: 'configLoad',
    label: t('doctor.check.configLoad'),
    level: 'ok',
    detail: input.sources.length > 0 ? input.sources.join(', ') : t('cli.defaultsOnly'),
  });

  input.warnings.forEach((warning, i) => {
    checks.push({
      id: `configWarning${i}`,
      label: t('doctor.check.configWarning'),
      level: 'warn',
      detail: warning,
    });
  });

  return checks;
}

async function providerChecks(
  config: Config,
  env: NodeJS.ProcessEnv,
  offline: boolean,
  fetchImpl?: typeof fetch,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const id = config.provider;
  const preset = isBuiltinProvider(id) ? PROVIDER_PRESETS[id] : undefined;
  const override = config.providers[id] ?? {};

  // 完整解析可能因为缺 key / 缺 baseURL / 缺 model 失败——那些都是要报告的
  // 结论,而不是中止体检的理由。失败时退回逐项展示已知信息。
  let resolved: ResolvedProvider | undefined;
  let resolveError: string | undefined;
  try {
    resolved = resolveProvider(config, env);
  } catch (error) {
    resolveError = error instanceof Error ? error.message : String(error);
  }

  const baseURL = resolved?.baseURL ?? override.baseURL ?? preset?.baseURL;
  checks.push({
    id: 'provider',
    label: t('doctor.check.provider'),
    level: baseURL ? 'ok' : 'fail',
    detail: baseURL
      ? `${id} · ${resolved?.label ?? override.label ?? preset?.label ?? id} · ${baseURL}`
      : id,
    ...(baseURL ? {} : { hint: t('doctor.providerUnknown', { list: Object.keys(PROVIDER_PRESETS).join(', ') }) }),
  });

  // 顺序要和 resolveProvider 一致:自定义的 apiKeyEnv 先试,没设值时**仍然**
  // 回落到预设那几个变量。只列自定义那一个的话,密钥其实来自 DEEPSEEK_API_KEY
  // 时这一行会没有来源可写,缺密钥时给的提示也会漏掉真正管用的变量名。
  const envNames = [
    ...(override.apiKeyEnv ? [override.apiKeyEnv] : []),
    ...(preset?.apiKeyEnv ?? []).filter((name) => name !== override.apiKeyEnv),
  ];
  const envName = envNames.find((name) => env[name]?.trim());
  const keySource = override.apiKey
    ? t('doctor.keyFromConfig', { path: `providers.${id}.apiKey` })
    : envName
      ? t('doctor.keyFromEnv', { name: envName })
      : undefined;
  const apiKey = resolved?.apiKey ?? override.apiKey ?? (envName ? env[envName]?.trim() : undefined);
  checks.push({
    id: 'apiKey',
    label: t('doctor.check.apiKey'),
    level: apiKey ? 'ok' : 'fail',
    detail: apiKey ? `${keySource ?? ''} ${mask(apiKey)}`.trim() : t('doctor.keyMissing'),
    ...(apiKey
      ? {}
      : {
          hint: t('doctor.keyHint', {
            envs: envNames.length > 0 ? envNames.join(' | ') : `providers.${id}.apiKey`,
          }),
        }),
  });

  const model = resolved?.model ?? config.model ?? override.model ?? preset?.defaultModel;
  checks.push({
    id: 'model',
    label: t('doctor.check.model'),
    level: model ? 'ok' : 'fail',
    detail: model
      ? `${model} · ${t('doctor.contextWindow', { n: String(resolved?.contextWindow ?? config.maxContext ?? override.contextWindow ?? preset?.defaultContextWindow ?? 0) })}`
      : t('doctor.modelMissing'),
    ...(model ? {} : { hint: t('doctor.modelHint', { id }) }),
  });

  if (!resolved) {
    // baseURL/key/model 三行已经把原因说清楚了;这里只在还有别的解析错误时补一条。
    if (resolveError && apiKey && baseURL && model) {
      checks.push({
        id: 'providerResolve',
        label: t('doctor.check.provider'),
        level: 'fail',
        detail: resolveError,
      });
    }
    return checks;
  }

  if (offline) {
    checks.push({
      id: 'endpoint',
      label: t('doctor.check.endpoint'),
      level: 'info',
      detail: t('doctor.skippedOffline'),
    });
    return checks;
  }

  const target = resolved;
  const probe = await probeModels(target, {
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const ms = `${probe.durationMs}ms`;

  if (probe.ok) {
    const models = probe.models ?? [];
    checks.push({
      id: 'endpoint',
      label: t('doctor.check.endpoint'),
      level: 'ok',
      detail: t('doctor.endpointOk', { n: String(models.length), ms }),
    });
    // 端点给了列表却没有当前模型:多半是模型 id 过期(README 反复强调的坑)。
    if (models.length > 0 && !models.some((m) => m.id === target.model)) {
      checks.push({
        id: 'modelListed',
        label: t('doctor.check.modelListed'),
        level: 'warn',
        detail: t('doctor.modelUnlisted', { model: target.model }),
        hint: t('doctor.modelUnlistedHint', { id: target.id }),
      });
    }
    return checks;
  }

  // 401/403 是密钥问题,必修;404/405 与形状不对(200 但没有 data 数组)只说明
  // 这个端点不提供模型列表,对话本身可能完全正常(自建网关常见),报告为告警。
  const status = probe.status;
  const authFailure = status === 401 || status === 403;
  const noListing = status === 404 || status === 405 || status === 200;
  checks.push({
    id: 'endpoint',
    label: t('doctor.check.endpoint'),
    level: authFailure || !noListing ? 'fail' : 'warn',
    detail: `${probe.error ?? ''} · ${ms}`,
    hint: authFailure
      ? t('doctor.endpointAuthHint', { id: target.id })
      : noListing
        ? t('doctor.endpointNoListingHint')
        : t('doctor.endpointFailHint'),
  });
  return checks;
}

function permissionChecks(config: Config): DoctorCheck[] {
  const perms = { sandbox: config.sandbox, approval: config.approval };
  const dangerous = config.sandbox === 'danger-full-access';
  const rules = config.permissions;
  return [
    {
      id: 'mode',
      label: t('doctor.check.mode'),
      level: dangerous ? 'warn' : 'ok',
      detail:
        `${config.sandbox} · ${config.approval} (${permissionsLabel(perms)})` +
        (config.plan ? ` · ${t('doctor.planOn')}` : ''),
      ...(dangerous ? { hint: t('doctor.dangerHint') } : {}),
    },
    {
      id: 'rules',
      label: t('doctor.check.rules'),
      level: 'info',
      detail:
        `allowBash ${rules.allowBash.length} · denyBash ${rules.denyBash.length} · ` +
        `allowWrite ${rules.allowWrite.length} · denyPath ${rules.denyPath.length}`,
    },
  ];
}

async function mcpChecks(
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

async function sessionChecks(dir: string, config?: Config): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const exists = await fileExists(dir);
  // 目录还没建过很正常,此时看祖先能不能写。必须一路往上找到真正存在的那一层:
  // 全新安装时 ~/.mojocode 连同 sessions/ 整棵都还没有(第一次存会话或
  // `mojocode auth` 才创建),只看父目录会 ENOENT,把干净的新装误判成"不可写"
  // ——那会让第一次跑 doctor 的人直接看到一条异常加退出码 1。
  const target = exists ? dir : await firstExisting(path.dirname(dir));
  const writable = await isWritable(target);
  checks.push({
    id: 'sessionsDir',
    label: t('doctor.check.sessionsDir'),
    level: writable ? 'ok' : 'fail',
    detail: `${dir}${exists ? '' : ` · ${t('doctor.willBeCreated')}`}`,
    ...(writable ? {} : { hint: t('doctor.sessionsDirHint', { path: target }) }),
  });

  let count = 0;
  let bytes = 0;
  if (exists) {
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (file.endsWith('.jsonl')) count += 1;
        if (!file.endsWith('.jsonl') && !file.endsWith('.meta.json')) continue;
        const stat = await fs.stat(path.join(dir, file)).catch(() => undefined);
        bytes += stat?.size ?? 0;
      }
    } catch {
      // 目录读不动的情况上面那条检查已经报了。
    }
  }
  checks.push({
    id: 'sessionsUsage',
    label: t('doctor.check.sessionsUsage'),
    level: 'info',
    detail: t('doctor.sessionsUsage', {
      n: String(count),
      size: formatBytes(bytes),
      days: String(config?.cleanupPeriodDays ?? 30),
    }),
  });

  return checks;
}

async function workspaceChecks(root: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  // 目录不存在与目录不可写要分开说:`-C` 打错一个字时,"不可写"这句提示
  // 会把人引向权限问题,而真正的原因是路径根本不存在(loadRawConfig 对
  // 不存在的 root 是静默成功的,别处也不会兜出这个错)。
  const exists = await fileExists(root);
  const writable = exists && (await isWritable(root));
  checks.push({
    id: 'cwd',
    label: t('doctor.check.cwd'),
    level: writable ? 'ok' : exists ? 'warn' : 'fail',
    detail: root,
    ...(writable ? {} : { hint: exists ? t('doctor.cwdHint') : t('doctor.cwdMissing') }),
  });

  checks.push({
    id: 'git',
    label: t('doctor.check.git'),
    level: 'info',
    // worktree 里 .git 是文件而不是目录,所以只判断存在。
    detail: (await fileExists(path.join(root, '.git'))) ? t('doctor.gitRepo') : t('doctor.gitNone'),
  });

  const memoryFiles: string[] = [];
  for (const name of ['AGENTS.md', 'MOJOCODE.md', 'CLAUDE.md']) {
    if (await fileExists(path.join(root, name))) memoryFiles.push(name);
  }
  checks.push({
    id: 'memory',
    label: t('doctor.check.memory'),
    level: 'info',
    detail: memoryFiles.length > 0 ? memoryFiles.join(', ') : t('doctor.memoryNone'),
  });

  return checks;
}

async function latestVersion(fetchImpl?: typeof fetch): Promise<string | undefined> {
  const doFetch = fetchImpl ?? fetch;
  try {
    const res = await doFetch(REGISTRY_URL, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { version?: unknown };
    return typeof json.version === 'string' ? json.version : undefined;
  } catch {
    // 没网、被墙、registry 抽风——都不该让体检失败,版本行降级为"未知"。
    return undefined;
  }
}

/** 只比较 `x.y.z` 三段数字;预发布后缀(-beta.1)按小于同号正式版处理。 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: boolean } => {
    const [core = '', ...rest] = v.trim().replace(/^v/, '').split('-');
    return {
      nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0),
      pre: rest.length > 0,
    };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  return left.pre ? -1 : 1;
}

/** 密钥打码:留头尾各 4 位定位是哪一把,中间抹掉。 */
function mask(key: string): string {
  if (key.length <= 12) return '*'.repeat(Math.max(key.length, 4));
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** 沿路径向上找到第一个真实存在的祖先。用于判断"还没建的目录能不能建出来"。 */
async function firstExisting(target: string): Promise<string> {
  let dir = target;
  for (;;) {
    if (await fileExists(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

async function isWritable(target: string): Promise<boolean> {
  try {
    await fs.access(target, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const SYMBOLS: Record<CheckLevel, string> = { ok: '✓', warn: '!', fail: '✗', info: '·' };
const COLORS: Record<CheckLevel, string> = {
  ok: '\u001b[32m',
  warn: '\u001b[33m',
  fail: '\u001b[31m',
  info: '\u001b[90m',
};

/** 渲染成人读的报告。`color` 由调用方按 TTY / NO_COLOR 决定。 */
export function formatDoctor(report: DoctorReport, options: { color?: boolean } = {}): string {
  const color = options.color === true;
  const paint = (text: string, code: string): string => (color ? `${code}${text}\u001b[0m` : text);
  const lines: string[] = [`${t('doctor.title')} · v${report.version}`, ''];

  for (const section of report.sections) {
    lines.push(paint(section.title, '\u001b[1m'));
    const width = Math.max(0, ...section.checks.map((c) => stringWidth(c.label)));
    for (const check of section.checks) {
      const pad = ' '.repeat(Math.max(0, width - stringWidth(check.label)));
      const symbol = paint(SYMBOLS[check.level], COLORS[check.level]);
      // 多行 detail(端点返回的错误体)要跟着缩进,否则会顶到行首破坏对齐。
      // 列位 = 2 缩进 + 1 符号 + 1 空格 + label 宽 + 2 分隔,与下面的 hint 行一致。
      const detail = (check.detail ?? '').split('\n').join(`\n${' '.repeat(width + 6)}`);
      lines.push(`  ${symbol} ${check.label}${pad}  ${detail}`.trimEnd());
      if (check.hint) lines.push(`  ${' '.repeat(width + 2)}  → ${check.hint}`);
    }
    lines.push('');
  }

  lines.push(
    t('doctor.summary', {
      ok: String(report.counts.ok),
      warn: String(report.counts.warn),
      fail: String(report.counts.fail),
    }),
  );
  return `${lines.join('\n')}\n`;
}
