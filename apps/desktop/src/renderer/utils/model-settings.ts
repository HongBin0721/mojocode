/**
 * 设置页·模型设置与 Composer 模型选择器共用的纯推导(Node 测试环境可直测)。
 *
 * 快照里的 config 是脱敏副本:`providers.*.apiKey` 被替换成空串但保留键,
 * 所以"配过 key"一律用 `!== undefined` 判断,绝不能用真值判断(CLAUDE.md
 * 记录过的坑)。预设 key 也可能只存在于 server 侧环境变量——客户端看不见,
 * 这里的 configured 只代表"配置文件里有痕迹",当前激活的 provider 无条件
 * 算已配置。
 */

import { BUILTIN_PROVIDER_IDS, PROVIDER_PRESETS, isBuiltinProvider } from '@core/providers';
import type { Config, ProviderConfig, ProviderModelEntry } from '@core/schema';
import type { ProviderModelsSummary } from '../../shared/ipc.js';

export interface ProviderListItem {
  id: string;
  label: string;
  /** 配置文件里有 key/条目,或就是当前激活的 provider(列表里的绿点)。 */
  configured: boolean;
  builtin: boolean;
}

export function providerLabel(id: string, override?: ProviderConfig): string {
  const preset = isBuiltinProvider(id) ? PROVIDER_PRESETS[id] : undefined;
  return override?.label ?? preset?.label ?? id;
}

/** 设置页左列:预设组(全部内置 id)+ 自定义组(配置里出现的其他键)。 */
export function providerList(
  config: Config | undefined,
  currentId: string | undefined,
): { presets: ProviderListItem[]; custom: ProviderListItem[] } {
  const providers = config?.providers ?? {};
  const presets = BUILTIN_PROVIDER_IDS.map((id) => ({
    id,
    label: providerLabel(id, providers[id]),
    configured: providers[id]?.apiKey !== undefined || id === currentId,
    builtin: true,
  }));
  const custom = Object.entries(providers)
    .filter(([id]) => !isBuiltinProvider(id))
    .map(([id, override]) => ({
      id,
      label: providerLabel(id, override),
      // 自定义条目写进配置就算配置过(本地端点不需要 key)。
      configured: true,
      builtin: false,
    }));
  return { presets, custom };
}

/**
 * 「添加供应商」表单只收显示名(对齐 ZCode),配置键由名称派生:小写、
 * 非字母数字折叠成连字符;非 ASCII 名称(纯中文)剥完为空时回落 'custom'。
 * 与既有键(内置 + 配置文件里的)冲突时追加 -2/-3…,保证不覆盖。
 */
export function deriveProviderId(name: string, config: Config | undefined): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'custom';
  const taken = new Set<string>([...BUILTIN_PROVIDER_IDS, ...Object.keys(config?.providers ?? {})]);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * 模型弹窗保存时的列表写入:`at === 'new'` 追加(同 id 先去重,重复添加是
 * 覆盖不是双份);数字下标则按位替换(编辑改 id 撞上既有条目时**不**去重,
 * 交给端点报错——静默吞掉另一行更糟)。AddProviderForm 与 ProviderDetail
 * 共用,语义只在这一处。
 */
export function upsertModel(
  models: ProviderModelEntry[],
  at: number | 'new',
  entry: ProviderModelEntry,
): ProviderModelEntry[] {
  return at === 'new'
    ? [...models.filter((m) => m.id !== entry.id), entry]
    : models.map((m, i) => (i === at ? entry : m));
}

/**
 * Composer 模型选择器的配置直读数据源:任一 provider 配置了 models 列表,
 * 就以这些列表构建分组(同步、零探测),当前 provider 排第一;全都没配置
 * 时返回 undefined,选择器回落到 listProviderModels 探测。contextWindows
 * 由逐模型 contextWindow 汇成映射,预设已知窗口作兜底(与探测路径同源)。
 *
 * 激活 provider 自己没配 models 列表时**不能从选择器消失**(别的 provider
 * 配了列表就把它挤没了,正在跑的模型连 ✓ 都没处打):兜一个只含当前模型的
 * 组——只列真实在用的,不虚构预设列表(会过时,catalog 的教训)。
 */
export function configuredModelGroups(
  config: Config | undefined,
  currentId: string | undefined,
  currentModel?: string,
): ProviderModelsSummary[] | undefined {
  if (!config) return undefined;
  const groups: ProviderModelsSummary[] = [];
  for (const [id, override] of Object.entries(config.providers ?? {})) {
    const models: ProviderModelEntry[] | undefined = override?.models;
    if (!models || models.length === 0) continue;
    const preset = isBuiltinProvider(id) ? PROVIDER_PRESETS[id] : undefined;
    const contextWindows: Record<string, number> = preset ? { ...preset.contextWindows } : {};
    for (const model of models) {
      if (model.contextWindow) contextWindows[model.id] = model.contextWindow;
    }
    groups.push({
      providerId: id,
      label: providerLabel(id, override),
      contextWindows,
      models: models.map((model) => ({ id: model.id })),
    });
  }
  if (groups.length === 0) return undefined;
  if (currentId && currentModel && !groups.some((g) => g.providerId === currentId)) {
    const override = config.providers?.[currentId];
    const preset = isBuiltinProvider(currentId) ? PROVIDER_PRESETS[currentId] : undefined;
    groups.push({
      providerId: currentId,
      label: providerLabel(currentId, override),
      contextWindows: preset ? { ...preset.contextWindows } : {},
      models: [{ id: currentModel }],
    });
  }
  groups.sort((a, b) =>
    a.providerId === currentId ? -1 : b.providerId === currentId ? 1 : 0,
  );
  return groups;
}
