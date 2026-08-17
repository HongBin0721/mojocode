/**
 * 档位 id → 本地化短标签。权限档(read-only/ask/auto/full-access/plan)预设
 * id 有对应 mode.* 文案,自由组合("sandbox·approval" 形)原样展示——
 * Composer 的模式 chip、权限菜单、时间线 banner 的模式 pill 共用;思考强度
 * 同构走 effort.*(Composer chip 用;ReasoningMenu 的档名按其文件头约定保持
 * 英文模型参数,不走这里)。
 */

import type { ReasoningEffort } from '@core/schema';
import { t } from '../i18n/index.js';

const MODE_KEYS = {
  'read-only': 'mode.read-only',
  ask: 'mode.ask',
  auto: 'mode.auto',
  'full-access': 'mode.full-access',
  plan: 'mode.plan',
} as const;

export function localizeMode(badge: string): string {
  return badge in MODE_KEYS ? t(MODE_KEYS[badge as keyof typeof MODE_KEYS]) : badge;
}

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
