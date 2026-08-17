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

/**
 * 条目表:按 schema 声明序,当前档打标。`levels` 是该模型实际可选的档位
 * (models.dev 能力目录,Composer 按当前 provider/model 拉取);缺省 = 全量
 * (库里查不到时不瞎猜)。两条例外规则:
 * - 'auto' 永不列出(用户的决定):它是"什么参数都不发"的初始默认态,chip 上
 *   以「自动」描述现状,但不作为可点的档位;
 * - 其余当前档恒保留——列表把它藏掉只会让 chip 与菜单对不上。
 */
export function reasoningMenuEntries(
  current: ReasoningEffort,
  levels?: ReasoningEffort[],
): ReasoningMenuEntry[] {
  const allowed = new Set<ReasoningEffort>(levels ?? REASONING_EFFORTS);
  if (current !== 'auto') allowed.add(current);
  return REASONING_EFFORTS.filter((level) => level !== 'auto' && allowed.has(level)).map(
    (level) => ({
      level,
      current: level === current,
    }),
  );
}

/** 选择一档 → RPC。纯函数,单测锁定。 */
export function setReasoningRpc(level: ReasoningEffort): RpcRequest {
  return { kind: 'setReasoningEffort', level };
}
