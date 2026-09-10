/**
 * 「把任意抛出物变成一句话」的唯一实现。
 *
 * 这件事在三个地方各写过一遍(loop 的 errorMessage、hooked-tools 的
 * errorText、hooks 的 toError),分支还不完全一致——同一个抛出物在钩子里
 * 和在循环里可能被读成不同的字符串,而没有任何东西拦着它们继续漂。它住在
 * `core/` 是因为消费方跨层:`core/hooks.ts` 用它,`agent/` 也用它,反过来
 * 让核心 import agent 是错的方向。
 */

/**
 * 抛出物的可读文本。非 Error 的字符串原样用,其余序列化兜底。
 *
 * **序列化必须兜住**:这个函数的调用点全在 catch 块里(钩子的 onError、
 * 工具错误的改写、loop 的 normalizeError),而 `JSON.stringify` 对循环引用
 * 直接抛 TypeError——从 catch 里再抛出去就绕过了本该兜底的那一层,最坏是
 * `followUp` 的 `void run()` 变成未捕获的 rejection。`undefined`/symbol 让
 * stringify 返回 `undefined`(不是字符串),同样要接住:返回类型说的是 string。
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    const json = JSON.stringify(error);
    if (typeof json === 'string') return json;
  } catch {
    // 循环引用等:退到 String()。
  }
  return String(error);
}

/** 抛出物规范成 Error(已经是的原样返回,子类与堆栈都保住)。 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errorMessage(error));
}
