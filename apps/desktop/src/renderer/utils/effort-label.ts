/**
 * 思考强度档位 id → 本地化短标签(Composer chip 用;ReasoningMenu 的档名按
 * 其文件头约定保持英文模型参数,不走这里)。
 */

import type { ReasoningEffort } from '@core/schema';
import { t } from '../i18n/index.js';

const EFFORT_KEYS = {
  auto: 'effort.auto',
  off: 'effort.off',
  low: 'effort.low',
  medium: 'effort.medium',
  high: 'effort.high',
  max: 'effort.max',
} as const satisfies Record<ReasoningEffort, string>;

export function localizeEffort(level: ReasoningEffort): string {
  return t(EFFORT_KEYS[level]);
}
