import type { JSONValue } from 'ai';
import type { ResolvedProvider } from '../config/load.js';
import { REASONING_EFFORTS, type ReasoningEffort } from '../config/schema.js';

/** streamText 的 providerOptions 形状:provider 键 → 该 provider 的选项对象。 */
export type ProviderOptionsMap = Record<string, Record<string, JSONValue>>;

export interface ReasoningMapping {
  providerOptions?: ProviderOptionsMap;
  /** full=完整表达;coarse=只能粗粒度近似(如仅开关);unsupported=该 provider/model 无法表达。 */
  support: 'full' | 'coarse' | 'unsupported';
}

/** kimi-k3 / kimi-k2.7 走顶层 reasoning_effort(low|high|max),更早的 k2.x 只有 thinking 开关。 */
function isKimiEffortModel(model: string): boolean {
  return model.startsWith('kimi-k3') || model.startsWith('kimi-k2.7');
}

/**
 * openai-compatible 的 providerOptions 键。SDK 两种拼写都读,但带连字符的
 * 原名(glm-coding、kimi-intl)会触发弃用警告——它经 console.warn 输出,会
 * 直接打进 TUI 的全屏画面。统一用 SDK 期望的 camelCase 形式。
 */
export function providerOptionsKey(providerId: string): string {
  return providerId.replace(/[_-]([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * 把用户档位翻译成各 provider 实际接受的请求参数。无法完整表达时静默降级
 * (发送最佳近似或什么都不发),`support` 供 UI 在选择时做一次性提示。
 * 不用 ai SDK 顶层的统一 `reasoning` 参数:openai-compatible 会丢弃 'none',
 * 无法表达"显式关闭",且档位字符串会原样透传给不认识它的服务端。
 */
export function reasoningMapping(
  provider: ResolvedProvider,
  effort: ReasoningEffort,
): ReasoningMapping {
  // auto = 保持现状,交给服务端默认。
  if (effort === 'auto') return { support: 'full' };

  // deepseek 专用包:providerOptions 键固定为 'deepseek'(与 provider.id 无关),
  // 且只认 zod schema 里的规范键 thinking / reasoningEffort,任意字段不透传。
  if (provider.sdk === 'deepseek') {
    if (effort === 'off') {
      return { support: 'full', providerOptions: { deepseek: { thinking: { type: 'disabled' } } } };
    }
    return {
      support: 'full',
      providerOptions: { deepseek: { thinking: { type: 'enabled' }, reasoningEffort: effort } },
    };
  }

  // openai-compatible:reasoningEffort 是规范键(映射为 body 的 reasoning_effort),
  // 其余键(如 thinking)会被原样展开进请求体——GLM 靠这个机制注入。
  // 家族判断用原始 id(glm-coding、kimi-intl 都要归到对应家族),
  // 但写入 providerOptions 时用 camelCase 键。
  const id = provider.id;
  const key = providerOptionsKey(id);

  if (id.startsWith('glm')) {
    // GLM 只有 thinking 开关,没有档位,非 off 一律等于开启。
    return {
      support: effort === 'off' ? 'full' : 'coarse',
      providerOptions: { [key]: { thinking: { type: effort === 'off' ? 'disabled' : 'enabled' } } },
    };
  }

  if (id.startsWith('kimi')) {
    if (isKimiEffortModel(provider.model)) {
      // k3 / k2.7 系无法关闭思考,off 不可表达。
      if (effort === 'off') return { support: 'unsupported' };
      // Moonshot 只接受 low|high|max,medium 就近归到 high。
      const mapped = effort === 'medium' ? 'high' : effort;
      return {
        support: effort === 'medium' ? 'coarse' : 'full',
        providerOptions: { [key]: { reasoningEffort: mapped } },
      };
    }
    // k2.6 / k2.5 等旧模型:只有 thinking 开关。
    return {
      support: effort === 'off' ? 'full' : 'coarse',
      providerOptions: { [key]: { thinking: { type: effort === 'off' ? 'disabled' : 'enabled' } } },
    };
  }

  // 自定义 provider:按 OpenAI 惯例透传 reasoning_effort;"关闭思考"没有通用表达。
  if (effort === 'off') return { support: 'unsupported' };
  return { support: 'full', providerOptions: { [key]: { reasoningEffort: effort } } };
}

/**
 * 当前 provider/model 能完整表达的档位——/think 选择器的选项来源与校验依据。
 * 粗粒度近似(coarse)的档位不在其中:GLM 这类只有开关的模型,low/high 都只是
 * "开启思考",展示出来会误导;回到默认开启选 auto 即可。配置文件里手写的
 * coarse 值仍会被 reasoningMapping 静默降级,不报错。
 */
export function supportedEfforts(provider: ResolvedProvider): ReasoningEffort[] {
  return REASONING_EFFORTS.filter((e) => reasoningMapping(provider, e).support === 'full');
}

/**
 * 按 provider 键做一层深合并。parallel_tool_calls 与思考参数要落在同一个
 * provider 键下,直接展开会整体覆盖,必须先合并再传给 streamText。
 */
export function mergeProviderOptions(
  ...maps: Array<ProviderOptionsMap | undefined>
): ProviderOptionsMap | undefined {
  const out: ProviderOptionsMap = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [key, value] of Object.entries(map)) {
      out[key] = { ...out[key], ...value };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
