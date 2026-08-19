/**
 * models.dev 能力查询 hook,Composer(思考 chip 档位)与 ModelModal(预填/
 * 收窄)共用。目录在 server 侧 24h 静态,renderer 里再按 (providerId, modelId)
 * 做模块级缓存——设置页往返、弹窗逐字输入不再反复走 IPC+HTTP。
 * miss(目录没这个模型)也缓存(null),否则弹窗每个防抖停顿都白打一次;
 * RPC 失败不缓存,下次重试。`debounceMs` 给弹窗的逐字输入用。
 */

import { useEffect, useState } from 'react';
import type { ModelCapabilitiesSummary } from '../../shared/ipc.js';
import { rpcCall } from '../bridge/invoke.js';

const cache = new Map<string, ModelCapabilitiesSummary | null>();

/** 测试出口:模块级缓存跨用例保留,mock 变更前得清掉。 */
export function clearModelCapabilitiesCache(): void {
  cache.clear();
}

export function useModelCapabilities(
  providerId: string | undefined,
  modelId: string | undefined,
  options: { debounceMs?: number } = {},
): ModelCapabilitiesSummary | undefined {
  const [caps, setCaps] = useState<ModelCapabilitiesSummary | undefined>();
  const { debounceMs } = options;
  useEffect(() => {
    setCaps(undefined);
    if (!modelId) return;
    // NUL 转义作分隔符(id 里不可能出现);必须写转义而非字面 0x00 字节,
    // 否则整个文件被 grep/git 判为二进制。
    const key = `${providerId ?? ''}\u0000${modelId}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      setCaps(hit ?? undefined);
      return;
    }
    let alive = true;
    const query = () => {
      void rpcCall({ kind: 'modelCapabilities', id: providerId ?? '', model: modelId })
        .then((result) => {
          cache.set(key, result ?? null);
          if (alive) setCaps(result);
        })
        .catch(() => {});
    };
    const timer = debounceMs !== undefined ? setTimeout(query, debounceMs) : undefined;
    if (timer === undefined) query();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [providerId, modelId, debounceMs]);
  return caps;
}
