import { SEARCH_PRESETS, resolveSearchBackend } from '../../config/search.js';
import type { Config } from '../../config/schema.js';
import { t } from '../../i18n/index.js';
import type { DoctorCheck } from './types.js';
import { NETWORK_TIMEOUT_MS, mask } from './util.js';

/**
 * web_search 后端体检:后端解析 → key 来源 → 端点探测。探测发一次 count:1 的
 * 最小真实请求——GLM 按次计费(search_std 约 ¥0.01),这是有意的取舍:只验
 * key 存在性抓不住"key 有效但欠费/无权限"这类最常见的故障。
 */
export async function searchChecks(
  config: Config,
  env: NodeJS.ProcessEnv,
  offline: boolean,
  fetchImpl?: typeof fetch,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const configured = config.search.backend;
  const backend = resolveSearchBackend(config, env);

  if (!backend) {
    if (configured === 'off') {
      checks.push({
        id: 'searchBackend',
        label: t('doctor.check.searchBackend'),
        level: 'info',
        detail: t('doctor.searchOff'),
      });
    } else if (configured === 'auto') {
      // 配了专用 key 却仍解析不出,是 auto 刻意忽略它导致的——这时候再说
      // "去设个 key" 是误导,得直接指出该显式选后端。
      const hasExplicitKey = Boolean(
        config.search.apiKey ?? config.search.apiKeyEnv ?? env.MOJOCODE_SEARCH_API_KEY,
      );
      checks.push({
        id: 'searchBackend',
        label: t('doctor.check.searchBackend'),
        level: hasExplicitKey ? 'warn' : 'info',
        detail: hasExplicitKey ? t('doctor.searchAutoIgnoresKey') : t('doctor.searchNone'),
        ...(hasExplicitKey ? { hint: t('doctor.searchAutoHint') } : {}),
      });
    } else {
      const envs = searchKeyEnvNames(config, configured);
      checks.push({
        id: 'searchBackend',
        label: t('doctor.check.searchBackend'),
        level: 'warn',
        detail: t('doctor.searchBackendMissing', { backend: configured }),
        hint: t('doctor.searchKeyHint', {
          envs: envs.length > 0 ? envs.join(' | ') : 'search.apiKey + search.baseURL',
        }),
      });
    }
    return checks;
  }

  checks.push({
    id: 'searchBackend',
    label: t('doctor.check.searchBackend'),
    level: 'ok',
    detail: `${backend.id} · ${backend.label}${configured === 'auto' ? ' (auto)' : ''}`,
  });

  // key 来源:与 resolveSearchBackend 的取值顺序一致地回溯。
  const envName = searchKeyEnvNames(config, backend.id).find(
    (name) => env[name]?.trim() === backend.apiKey,
  );
  const keySource =
    config.search.apiKey === backend.apiKey
      ? t('doctor.keyFromConfig', { path: 'search.apiKey' })
      : envName
        ? t('doctor.keyFromEnv', { name: envName })
        : undefined;
  checks.push({
    id: 'searchKey',
    label: t('doctor.check.searchKey'),
    level: 'ok',
    detail: `${keySource ?? ''} ${mask(backend.apiKey)}`.trim(),
  });

  if (offline) {
    checks.push({
      id: 'searchEndpoint',
      label: t('doctor.check.searchEndpoint'),
      level: 'info',
      detail: t('doctor.skippedOffline'),
    });
    return checks;
  }

  const doFetch = fetchImpl ?? fetch;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (backend.auth === 'x-api-key') headers['x-api-key'] = backend.apiKey;
  else headers.authorization = `Bearer ${backend.apiKey}`;
  const body =
    backend.id === 'exa'
      ? { query: 'mojocode doctor probe', numResults: 1 }
      : { search_query: 'mojocode doctor probe', search_engine: backend.engine ?? 'search_std', count: 1 };

  const started = Date.now();
  try {
    const res = await doFetch(backend.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    const ms = `${Date.now() - started}ms`;
    if (res.ok) {
      checks.push({
        id: 'searchEndpoint',
        label: t('doctor.check.searchEndpoint'),
        level: 'ok',
        detail: t('doctor.searchEndpointOk', { ms }),
      });
    } else {
      const authFailure = res.status === 401 || res.status === 403;
      checks.push({
        id: 'searchEndpoint',
        label: t('doctor.check.searchEndpoint'),
        level: authFailure ? 'fail' : 'warn',
        detail: `HTTP ${res.status} · ${ms}`,
        hint: authFailure
          ? t('doctor.searchEndpointAuthHint', { backend: backend.id })
          : t('doctor.searchEndpointFailHint'),
      });
    }
  } catch (err) {
    // 没网、被墙、超时都归 warn:搜索是可选能力,不该把体检整体判为不健康。
    checks.push({
      id: 'searchEndpoint',
      label: t('doctor.check.searchEndpoint'),
      level: 'warn',
      detail: `${(err as Error).message} · ${Date.now() - started}ms`,
      hint: t('doctor.searchEndpointFailHint'),
    });
  }
  return checks;
}

/** 与 resolveSearchBackend 的取值顺序一致的候选环境变量列表(用于提示与来源回溯)。 */
function searchKeyEnvNames(config: Config, backendId: string): string[] {
  const preset = backendId === 'glm' || backendId === 'exa' ? SEARCH_PRESETS[backendId] : undefined;
  const names = [
    ...(config.search.apiKeyEnv ? [config.search.apiKeyEnv] : []),
    'MOJOCODE_SEARCH_API_KEY',
    ...(preset?.apiKeyEnv ?? []),
  ];
  return [...new Set(names)];
}
