import { resolveProvider, type ResolvedProvider } from '../../config/load.js';
import {
  PROVIDER_PRESETS,
  isBuiltinProvider,
  isVisionModel,
  normalizeModelId,
  resolveVisionModelId,
} from '../../config/providers.js';
import type { Config } from '../../config/schema.js';
import { t } from '../../i18n/index.js';
import { probeModels } from '../../model/registry.js';
import type { DoctorCheck } from './types.js';
import { NETWORK_TIMEOUT_MS, mask } from './util.js';

export async function providerChecks(
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
  // 无 key 是否算缺陷要和 resolveProvider 同判:只有内置厂商(有预设)和声明了
  // apiKeyEnv 的自定义条目才必须要 key——本地 Ollama/vLLM 端点本来就不需要
  // 凭据,若在此判 fail,healthy=false 会让 `mojocode doctor` 的 CI 门禁用法
  // 对一份完全能用的配置退出 1。
  const keyRequired = preset !== undefined || override.apiKeyEnv !== undefined;
  checks.push({
    id: 'apiKey',
    label: t('doctor.check.apiKey'),
    level: apiKey ? 'ok' : keyRequired ? 'fail' : 'ok',
    detail: apiKey
      ? `${keySource ?? ''} ${mask(apiKey)}`.trim()
      : keyRequired
        ? t('doctor.keyMissing')
        : t('doctor.keyNotRequired'),
    ...(!apiKey && keyRequired
      ? {
          hint: t('doctor.keyHint', {
            envs: envNames.length > 0 ? envNames.join(' | ') : `providers.${id}.apiKey`,
          }),
        }
      : {}),
  });

  // model 也要过 normalizeModelId(GLM 老配置的小写 id),否则下面的
  // contextWindows 查表会落空。
  const rawModel = resolved?.model ?? config.model ?? override.model ?? preset?.defaultModel;
  const model = rawModel ? normalizeModelId(id, rawModel) : rawModel;
  // 窗口兜底链要和 resolveProvider 完全同序(per-model 表 → 默认值 → 128k),
  // 否则解析失败时展示的数字和修好问题后实际用的窗口对不上。
  const contextWindow =
    resolved?.contextWindow ??
    config.maxContext ??
    override.contextWindow ??
    preset?.contextWindows[model as keyof typeof preset.contextWindows] ??
    preset?.defaultContextWindow ??
    128_000;
  checks.push({
    id: 'model',
    label: t('doctor.check.model'),
    level: model ? 'ok' : 'fail',
    detail: model
      ? `${model} · ${t('doctor.contextWindow', { n: String(contextWindow) })}`
      : t('doctor.modelMissing'),
    ...(model ? {} : { hint: t('doctor.modelHint', { id }) }),
  });

  // view_image 的视觉模型(本地解析,不联网)。当前模型不吃图且无视觉模型可
  // 用时,贴图只会降级为"模型读不到"的文件引用——值得一条告警指路。
  const visionId = resolveVisionModelId(id, config);
  const currentIsVision = model !== undefined && isVisionModel(id, model, override.vision);
  checks.push({
    id: 'vision',
    label: t('doctor.check.vision'),
    level: visionId ? 'ok' : currentIsVision ? 'info' : 'warn',
    detail: visionId
      ? t('doctor.visionOk', { model: visionId })
      : currentIsVision
        ? t('doctor.visionNotNeeded')
        : t('doctor.visionNone'),
    ...(visionId || currentIsVision
      ? {}
      : {
          // 指引只推荐"该服务商自己的"多模态模型——报一个 glm 的 id 给
          // deepseek/kimi 用户,照做只会换来 404 或静默幻觉。
          hint: t('doctor.visionNoneHint', { id }),
        }),
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
