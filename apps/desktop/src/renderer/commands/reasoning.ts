/**
 * 思考强度档位菜单:枚举与类型直接复用根仓库 schema 的 REASONING_EFFORTS
 * (纯 zod 模块,已在 renderer 白名单),只做条目组装——与 permissions.ts
 * 同构。选择只改会话内档位,不落盘(设置面板在后续迭代)。
 */

import { REASONING_EFFORTS, type ReasoningEffort } from '@core/schema';
import type { RpcRequest } from '../../shared/ipc.js';

export interface ReasoningMenuEntry {
  level: ReasoningEffort;
  current: boolean;
}

/** 条目表:按 schema 声明序,当前档打标。 */
export function reasoningMenuEntries(current: ReasoningEffort): ReasoningMenuEntry[] {
  return REASONING_EFFORTS.map((level) => ({ level, current: level === current }));
}

/** 选择一档 → RPC。纯函数,单测锁定。 */
export function setReasoningRpc(level: ReasoningEffort): RpcRequest {
  return { kind: 'setReasoningEffort', level };
}
