/**
 * `-X name[=value]`(Pi 的 registerFlag 那一侧的命令行形态)→ 扩展经
 * `getFlag` 读的表:不带 `=` 是 true(布尔开关),带了是字符串,最终类型由
 * 扩展自己的声明决定(bootstrap 的 getFlag 按 type 解析)。
 *
 * 为什么是 `-X` 而不是 Pi 的裸 `--my-flag`:commander 对未声明的选项只能
 * 整体放行成位置参数,布尔开关后面跟的值分不清是它的值还是下一个参数;
 * 显式的 `-X` 是一个已声明的可重复选项,不用猜。
 */
export function parseExtensionFlags(
  raw: readonly string[] | undefined,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const item of raw ?? []) {
    const eq = item.indexOf('=');
    if (eq === -1) out[item] = true;
    else out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}
