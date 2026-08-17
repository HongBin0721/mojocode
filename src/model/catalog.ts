/**
 * models.dev 模型能力目录:逐模型的思考档位(reasoning_options)与上下文/
 * 输出上限(limit)的结构化数据源,替代 reasoning.ts 里按厂商家族猜档位的
 * 启发式(库里 glm-5.3 标注 effort low/high/max,而家族表只知道"GLM 有
 * thinking 开关"——手写表已经落后于现实)。
 *
 * 边界(与 CLAUDE.md 的说明一致):库只给**能力形状**(有哪些档位可选),
 * 不给**报文编码**(该写 reasoning_effort 还是 thinking.type)——编码仍由
 * reasoningMapping 负责;库里没有的模型(自定义本地端点)回退家族表,
 * 表达不了的思考开关走模型条目的自定义参数(reasoning 对象)。
 *
 * 拉取策略:~4MB 的静态 JSON,裁剪后落盘缓存(~/.mojocode/cache/),24h TTL;
 * 拉取失败用过期缓存兜底,连缓存都没有就返回 undefined(一切照旧)。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { globalDir } from '../config/paths.js';
import { REASONING_EFFORTS, type ReasoningEffort } from '../config/schema.js';

/** 裁剪后的单模型条目(只留我们消费的字段,解耦上游 schema 演化)。 */
export interface CatalogModel {
  reasoning: boolean;
  /** reasoning_options 里有 {type:'toggle'} → 思考可显式关闭。 */
  toggle: boolean;
  /** reasoning_options 里 effort 档位原文(可能含 none/minimal/xhigh 等枚举外值)。 */
  effortValues: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** models.dev 供应商 id → 模型 id(小写)→ 条目。 */
export type Catalog = Record<string, Record<string, CatalogModel>>;

/** mojocode 预设 id → models.dev 供应商 id。 */
export const PRESET_CATALOG_IDS: Record<string, string> = {
  kimi: 'moonshotai-cn',
  'kimi-coding': 'kimi-for-coding',
  'kimi-intl': 'moonshotai',
  deepseek: 'deepseek',
  glm: 'zhipuai',
  'glm-coding': 'zhipuai-coding-plan',
  'glm-intl': 'zai',
};

export const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
/** 拉取失败后的重试间隔:失败不能永久记住(断网启动后联网),也不能每次调用都打一枪。 */
const RETRY_AFTER_MS = 5 * 60 * 1000;

/** 上游原始形状里我们读取的部分(未验证,逐字段防御式取值)。 */
interface RawModel {
  reasoning?: unknown;
  reasoning_options?: unknown;
  limit?: { context?: unknown; output?: unknown };
}

/** 把上游全量 JSON 裁剪成 Catalog。任何形状异常的条目直接跳过,绝不抛。 */
export function pruneCatalog(raw: unknown): Catalog {
  const out: Catalog = {};
  if (raw === null || typeof raw !== 'object') return out;
  for (const [providerId, provider] of Object.entries(raw as Record<string, unknown>)) {
    const models = (provider as { models?: unknown })?.models;
    if (models === null || typeof models !== 'object') continue;
    const pruned: Record<string, CatalogModel> = {};
    for (const [modelId, model] of Object.entries(models as Record<string, unknown>)) {
      if (model === null || typeof model !== 'object') continue;
      const m = model as RawModel;
      const options = Array.isArray(m.reasoning_options) ? m.reasoning_options : [];
      const effortValues: string[] = [];
      let toggle = false;
      for (const option of options) {
        if (option === null || typeof option !== 'object') continue;
        const { type, values } = option as { type?: unknown; values?: unknown };
        if (type === 'toggle') toggle = true;
        if (type === 'effort' && Array.isArray(values)) {
          for (const v of values) if (typeof v === 'string') effortValues.push(v);
        }
      }
      const context = m.limit?.context;
      const output = m.limit?.output;
      pruned[modelId.toLowerCase()] = {
        reasoning: m.reasoning === true,
        toggle,
        effortValues,
        ...(typeof context === 'number' && context > 0 ? { contextWindow: context } : {}),
        ...(typeof output === 'number' && output > 0 ? { maxOutputTokens: output } : {}),
      };
    }
    if (Object.keys(pruned).length > 0) out[providerId] = pruned;
  }
  return out;
}

/**
 * 按 (mojocode provider id, model id) 查条目:预设先走 id 映射,没命中
 * (映射外的自定义条目 / 该供应商目录里缺的新模型)再全库按模型 id 撞——
 * 确定序遍历,优先带思考选项的条目(同名模型在聚合商与原厂间形状可能不同)。
 */
export function catalogModel(
  catalog: Catalog,
  providerId: string,
  modelId: string,
): CatalogModel | undefined {
  const lower = modelId.toLowerCase();
  const mapped = PRESET_CATALOG_IDS[providerId];
  const direct = mapped ? catalog[mapped]?.[lower] : undefined;
  if (direct) return direct;
  let fallback: CatalogModel | undefined;
  for (const pid of Object.keys(catalog).sort()) {
    const hit = catalog[pid]?.[lower];
    if (!hit) continue;
    if (hit.reasoning && (hit.toggle || hit.effortValues.length > 0)) return hit;
    fallback ??= hit;
  }
  return fallback;
}

/**
 * 目录条目 → 该模型可选的思考档位(内置枚举内)。'auto'(什么参数都不发)
 * 是 UI 之外的会话概念、不算模型能力,**不在**返回值里——选择器按用户的
 * 决定只列真实档位,配置/命令里显式写 auto 仍然合法。toggle 或 effort 值里
 * 的 'none' → 'off' 可选;档位原文与枚举求交(minimal/xhigh 等枚举外值丢弃)。
 *
 * 返回值分三态,混为一谈会让会思考的模型彻底关不掉思考(实测 1408 个条目
 * 落在第三态,其中就有 deepseek-reasoner 和 kimi-for-coding):
 *  - `[]`   目录明说该模型不推理(reasoning:false)——Composer 据此隐藏思考 chip;
 *  - 非空   目录给出的档位;
 *  - undefined 目录知道它推理、却没说档位形状(无 toggle 也无 effort 值)。
 *    这是**目录缺口**不是"没有档位",调用方必须回退家族表。
 */
export function effortChoices(info: CatalogModel): ReasoningEffort[] | undefined {
  if (!info.reasoning) return [];
  const set = new Set<ReasoningEffort>();
  if (info.toggle || info.effortValues.includes('none')) set.add('off');
  for (const value of info.effortValues) {
    if (value !== 'none' && (REASONING_EFFORTS as readonly string[]).includes(value)) {
      set.add(value as ReasoningEffort);
    }
  }
  if (set.size === 0) return undefined;
  return REASONING_EFFORTS.filter((effort) => set.has(effort));
}

/** GUI/TUI 消费的逐模型能力汇总。 */
export interface ModelCapabilities {
  contextWindow?: number;
  maxOutputTokens?: number;
  /**
   * 可选思考档位('auto' 不在内,见 effortChoices)。`undefined` = 目录没有
   * 档位信息,调用方回退家族表;`[]` = 该模型不推理。Session 的
   * `modelCapabilities` 已把回退与 wire 可表达性过滤做完,前端直接渲染。
   */
  efforts?: ReasoningEffort[];
}

export function capabilitiesFor(
  catalog: Catalog,
  providerId: string,
  modelId: string,
): ModelCapabilities | undefined {
  const info = catalogModel(catalog, providerId, modelId);
  if (!info) return undefined;
  const efforts = effortChoices(info);
  return {
    ...(info.contextWindow !== undefined ? { contextWindow: info.contextWindow } : {}),
    ...(info.maxOutputTokens !== undefined ? { maxOutputTokens: info.maxOutputTokens } : {}),
    ...(efforts !== undefined ? { efforts } : {}),
  };
}

interface CacheFile {
  fetchedAt: number;
  catalog: Catalog;
}

export interface CatalogSourceOptions {
  fetchImpl?: typeof fetch;
  cachePath?: string;
  ttlMs?: number;
  timeoutMs?: number;
  retryAfterMs?: number;
  /** 注入用,便于测试;默认 Date.now。 */
  now?: () => number;
}

export interface CatalogSource {
  /** 首次调用触发缓存读取/网络拉取;之后 memo。失败返回 undefined(过 retryAfterMs 后再试)。 */
  get(): Promise<Catalog | undefined>;
}

export function defaultCatalogCachePath(): string {
  return path.join(globalDir(), 'cache', 'models-dev.json');
}

/**
 * 进程内的目录访问器:磁盘缓存新鲜就用缓存;过期/缺失才走网络,成功后
 * 落盘;网络失败回过期缓存,连缓存都没有则 undefined 并在 retryAfterMs 后
 * 允许重试。所有路径都不抛——目录是增强,不是依赖。
 */
export function createCatalogSource(options: CatalogSourceOptions = {}): CatalogSource {
  const doFetch = options.fetchImpl ?? fetch;
  const cachePath = options.cachePath ?? defaultCatalogCachePath();
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const retryAfterMs = options.retryAfterMs ?? RETRY_AFTER_MS;
  const now = options.now ?? Date.now;

  let memo: Catalog | undefined;
  /** 网络失败时顶上的过期缓存:能用但**不**进 memo,否则再也不会去刷新。 */
  let staleMemo: Catalog | undefined;
  let pending: Promise<Catalog | undefined> | undefined;
  let lastFailureAt: number | undefined;

  const readCache = async (): Promise<CacheFile | undefined> => {
    try {
      const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8')) as CacheFile;
      if (typeof parsed?.fetchedAt === 'number' && parsed.catalog && typeof parsed.catalog === 'object') {
        return parsed;
      }
    } catch {
      /* 缺失/损坏都当无缓存。 */
    }
    return undefined;
  };

  /** `stale` 标记结果来自"网络失败 + 过期缓存"这条路,调用方据此不做长期 memo。 */
  const load = async (): Promise<{ catalog?: Catalog; stale?: boolean }> => {
    const cached = await readCache();
    if (cached && now() - cached.fetchedAt < ttlMs) return { catalog: cached.catalog };

    try {
      const res = await doFetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`GET ${MODELS_DEV_URL}: ${res.status}`);
      const catalog = pruneCatalog(await res.json());
      if (Object.keys(catalog).length === 0) throw new Error('empty catalog');
      try {
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, JSON.stringify({ fetchedAt: now(), catalog } satisfies CacheFile));
      } catch {
        /* 缓存写不进(只读 HOME 等)不影响本次使用。 */
      }
      return { catalog };
    } catch {
      // 网络失败:过期缓存也比没有强,但记下失败时间——网络恢复后要能刷新。
      lastFailureAt = now();
      return cached ? { catalog: cached.catalog, stale: true } : {};
    }
  };

  return {
    get: () => {
      if (memo) return Promise.resolve(memo);
      if (pending) return pending;
      // 退避窗口内不再打网络:有过期缓存就先用着(比 undefined 强),
      // 窗口一过就重试——目录能自愈,不必等进程重启。
      if (lastFailureAt !== undefined && now() - lastFailureAt < retryAfterMs) {
        return Promise.resolve(staleMemo);
      }
      pending = load().then(({ catalog, stale }) => {
        pending = undefined;
        if (catalog) {
          if (stale) staleMemo = catalog;
          else {
            memo = catalog;
            staleMemo = undefined;
          }
        }
        return catalog;
      });
      return pending;
    },
  };
}
