import type { Setter } from 'solid-js';
import { t } from '../i18n/index.js';
import type { ResolvedProvider } from '../config/load.js';
import type { ReasoningEffort } from '../config/schema.js';
import { saveApiKey, saveModelChoice, saveProviderChoice } from '../config/save.js';
import {
  BUILTIN_PROVIDER_IDS,
  PROVIDER_PRESETS,
  apiKeyFromEnv,
  isBuiltinProvider,
  type BuiltinProviderId,
} from '../config/providers.js';
import { listModels } from '../model/registry.js';
import type { ProviderRow } from './ProviderPicker.js';
import type { NewTimelineItem } from './types.js';
import type { UsageMirror } from './timeline-controller.js';
import type { SessionHandle } from '../app/session-handle.js';

/**
 * provider/model 切换的统一落地(原 App.tsx 的 landSwitch 一族,整段搬运)。
 * /provider、/models 两条命令与两个选择器共用的出口都在这里;App 经工厂
 * 注入 session、时间线 push 与四个镜像 setter,不携带任何自身状态。
 */

export interface ProviderActionsOptions {
  session: SessionHandle;
  push: (item: NewTimelineItem) => void;
  setProviderLabel: Setter<string>;
  setModel: Setter<string>;
  setThink: Setter<ReasoningEffort>;
  setUsage: Setter<UsageMirror>;
}

export interface ProviderActions {
  landSwitch: (
    next: ResolvedProvider,
    changed: boolean,
    persistModel: boolean,
  ) => Promise<void>;
  applyModelSwitch: (providerId: string | undefined, modelId: string) => Promise<void>;
  applyProviderSwitch: (id: string, apiKey?: string) => Promise<void>;
  providerRows: () => ProviderRow[];
  probeProviderKey: (id: string, key: string, signal?: AbortSignal) => Promise<number>;
}

export function createProviderActions(opts: ProviderActionsOptions): ProviderActions {
  const { session, push, setProviderLabel, setModel, setThink, setUsage } = opts;

  /**
   * `session.switch` 返回后的统一落地:刷新镜像、按"厂商是否变化"选分隔线
   * 文案、厂商变化时把默认厂商落盘。/provider 与 /models 两条路径共用——
   * "switch 之后必须发生什么"这份后果清单只允许有一份。
   *
   * changed 由调用方给定:/provider 一律视作切换(重选当前厂商也重新钉一
   * 遍),/models 按厂商实际变没变算。persistModel 只在用户显式选了模型时
   * 为真——/provider 的模型是回退解析出来的,不落盘。
   */
  const landSwitch = async (
    next: ResolvedProvider,
    changed: boolean,
    persistModel: boolean,
  ): Promise<void> => {
    if (changed) setProviderLabel(next.label);
    setModel(next.model);
    setThink(next.reasoningEffort);
    setUsage((prev) => ({ ...prev, window: next.contextWindow }));
    push({
      kind: 'divider',
      label: changed
        ? t('divider.switched', { label: next.label, model: next.model })
        : t('divider.modelNow', { model: next.model }),
    });
    if (changed) {
      await saveProviderChoice(next.id).catch((err: Error) => {
        push({ kind: 'notice', level: 'warn', message: t('notice.providerSaveFailed', { message: err.message }) });
      });
    }
    if (persistModel) {
      await saveModelChoice(next.id, next.model).catch((err: Error) => {
        push({ kind: 'notice', level: 'warn', message: t('notice.modelSaveFailed', { message: err.message }) });
      });
    }
  };

  /**
   * `/models <id>`(当前厂商)与分组选择器共用的切换落地。
   *
   * providerId 只在用户**显式点名**厂商(分组选择器里选了某组的行)时传:
   * 文本参数路径必须只发 { model },让 server 按它的实时 provider 解析——
   * 共享会话下 client 的 provider 镜像可能滞后,拿镜像值钉死会把别的
   * client 刚切过去的厂商又翻回来。
   */
  const applyModelSwitch = async (providerId: string | undefined, modelId: string): Promise<void> => {
    try {
      // 上一家厂商要在 switch 之前取:本地 Session 切完 provider 就地更新,
      // 远程镜像也会在 refreshState 后跟上,事后比是恒等的。
      const previousId = session.provider.id;
      const next = await session.switch(
        providerId ? { provider: providerId, model: modelId } : { model: modelId },
      );
      await landSwitch(next, next.id !== previousId, true);
    } catch (err) {
      push({ kind: 'error', message: (err as Error).message });
    }
  };

  /**
   * `/provider <id>` 与厂商选择器共用的切换落地。apiKey 只在"选择器里就地
   * 输入并验证(或强行保存)了新 key"时出现:先落盘,再随 switch 送到真正
   * 跑模型的进程(远程模式下 server 的内存配置看不到刚写进文件里的 key)。
   */
  const applyProviderSwitch = async (id: string, apiKey?: string): Promise<void> => {
    try {
      if (apiKey) {
        await saveApiKey(id, apiKey).catch((err: Error) => {
          push({ kind: 'notice', level: 'warn', message: t('notice.providerSaveFailed', { message: err.message }) });
        });
      }
      const next = await session.switch(apiKey ? { provider: id, apiKey } : { provider: id });
      await landSwitch(next, true, false);
    } catch (err) {
      push({ kind: 'error', message: (err as Error).message });
    }
  };

  /**
   * 厂商选择器的行数据:内置预设 + 配置文件里的自定义条目,标 ✓ 与有无 key。
   *
   * key 的有无一律按**字段存在**判断而不是真值:默认 client-server 模式下
   * session.config 是 redactConfig 过的镜像,配置文件里的 apiKey 被抹成 ''
   * (字段保留)——按真值判会把向导配好的每个厂商都标成 no key 逼用户重输。
   */
  const providerRows = (): ProviderRow[] => {
    const configured = session.config.providers;
    const rows: ProviderRow[] = BUILTIN_PROVIDER_IDS.map((id) => {
      const preset = PROVIDER_PRESETS[id];
      return {
        id,
        label: preset.label,
        baseURL: preset.baseURL,
        keyUrl: preset.keyUrl,
        hasKey:
          apiKeyFromEnv(preset.apiKeyEnv) !== undefined || configured[id]?.apiKey !== undefined,
        current: id === session.provider.id,
      };
    });
    for (const [id, def] of Object.entries(configured)) {
      if (isBuiltinProvider(id) || !def.baseURL) continue;
      rows.push({
        id,
        label: def.label ?? id,
        baseURL: def.baseURL,
        hasKey:
          def.apiKey !== undefined ||
          (def.apiKeyEnv ? apiKeyFromEnv([def.apiKeyEnv]) !== undefined : false),
        current: id === session.provider.id,
        // 自定义端点默认允许无凭据(本地服务);声明了 apiKeyEnv 的除外。
        keyOptional: def.apiKeyEnv === undefined,
      });
    }
    return rows;
  };

  /**
   * 厂商选择器的 key 探针:在本进程直接打 /models(纯 HTTP,不经会话)。
   * 抛错即验证失败,由 ProviderPicker 展示并给出重试/强存;signal 让
   * 验证中按 esc 能真正掐断挂起的请求。
   */
  const probeProviderKey = (id: string, key: string, signal?: AbortSignal): Promise<number> => {
    const preset = isBuiltinProvider(id) ? PROVIDER_PRESETS[id as BuiltinProviderId] : undefined;
    const override = session.config.providers[id];
    // override 优先——与 resolveProvider 同序:用户给内置厂商配了代理 baseURL
    // 时,拿代理签发的 key 去打官方端点必然 401,验证会拒掉一把好 key。
    const baseURL = override?.baseURL ?? preset?.baseURL;
    if (!baseURL) return Promise.reject(new Error(`Unknown provider "${id}"`));
    return listModels(
      {
        id,
        label: preset?.label ?? override?.label ?? id,
        baseURL,
        apiKey: key,
        model: preset?.defaultModel ?? 'custom',
        headers: override?.headers ?? {},
        contextWindow: preset?.defaultContextWindow ?? 128_000,
        parallelToolCalls: true,
        reasoningEffort: 'auto',
        sdk: 'openai-compatible',
      },
      signal ? { signal } : {},
    ).then((models) => models.length);
  };

  return { landSwitch, applyModelSwitch, applyProviderSwitch, providerRows, probeProviderKey };
}
