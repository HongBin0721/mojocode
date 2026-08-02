/**
 * App 测试里假 session 的 `goal` 桩。
 *
 * App 的提交路径经 `session.goal.run()` 而不是 `session.agent.run()`,esc 与
 * busy 判断也要问 `goal.busy`。假 session 都是 `as unknown as Session` 断言进
 * 去的,少了这个字段编译期看不出来、运行期直接炸在 undefined 上,所以每个
 * 假 session 都得带一个。
 *
 * 刻意不让 App 写成 `session.goal?.busy`:Session 类型里 goal 是必填的,
 * 可选链只会把 bootstrap 真接错线的情况一起盖掉。
 *
 * `run` 收 unknown:各个测试的假 run 签名不一,而整个 session 最终都要
 * `as unknown as Session`,在这里较真参数类型只会逼出一堆无谓的适配层。
 * 传进来的必须是返回 Promise 的函数——App 会对它 `.finally()`。
 */
export function stubGoal(run: unknown) {
  return {
    busy: false,
    active: false,
    state: undefined,
    snapshot: () => undefined,
    steer: () => false,
    run,
    set: () => {},
    restore: () => {},
    clear: () => {},
    dispose: () => {},
  };
}
