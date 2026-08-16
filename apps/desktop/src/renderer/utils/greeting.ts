/**
 * 空状态问候(ZCode 按时段问候):小时 → i18n key 的纯映射,
 * 边界(5/9/12/14/18/23)抽出来供单测锁定。
 */

export type GreetingKey =
  | 'greet.night'
  | 'greet.morning'
  | 'greet.forenoon'
  | 'greet.noon'
  | 'greet.afternoon'
  | 'greet.evening';

export function greetingKeyForHour(hour: number): GreetingKey {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h < 5) return 'greet.night';
  if (h < 9) return 'greet.morning';
  if (h < 12) return 'greet.forenoon';
  if (h < 14) return 'greet.noon';
  if (h < 18) return 'greet.afternoon';
  if (h < 23) return 'greet.evening';
  return 'greet.night';
}

/** 当前小时的问候 key(渲染入口)。 */
export function currentGreetingKey(): GreetingKey {
  return greetingKeyForHour(new Date().getHours());
}
