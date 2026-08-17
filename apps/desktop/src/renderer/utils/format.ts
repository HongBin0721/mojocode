/**
 * 展示格式化小工具。formatDuration/formatTokens 复制自 src/ui/theme.ts
 * (那边 import 了根 i18n,进不了 renderer)——上游改动时要跟。
 */

import { t } from '../i18n/index.js';

/** 路径最后一段作为项目名(侧栏分组标题 / 顶栏项目 chip 共用)。 */
export function projectName(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

/** ZCode 式紧凑相对时间(刚刚/2分/3时/4天,文案走 i18n),超 30 天落日期。 */
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return t('time.now');
  if (diffMs < 3600_000) return t('time.min', { n: Math.floor(diffMs / 60_000) });
  if (diffMs < 86_400_000) return t('time.hour', { n: Math.floor(diffMs / 3600_000) });
  if (diffMs < 30 * 86_400_000) return t('time.day', { n: Math.floor(diffMs / 86_400_000) });
  return date.toLocaleDateString();
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** 百分比(0–100 取整);分母非正返回 0,防 NaN 塌缩。 */
export function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}
