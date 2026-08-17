/**
 * 项目列表的纯函数(解析/增删):与 utils/sidebar.ts 同款分层——纯逻辑在
 * utils 供单测锁定,zustand 接线在 state/projectsStore.ts。
 */

/** 读列表:坏 JSON / 非字符串数组一律回空。 */
export function loadProjects(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

/** 追加:已存在时返回原数组引用(调用方据此跳过落盘)。 */
export function addProject(list: string[], root: string): string[] {
  return list.includes(root) ? list : [...list, root];
}

/** 移除:未命中时返回原数组引用。 */
export function removeProject(list: string[], root: string): string[] {
  return list.includes(root) ? list.filter((item) => item !== root) : list;
}
