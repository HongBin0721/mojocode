/**
 * App 测试里假 session 的扩展面桩(命令表 / 状态行 / 变化订阅 / runCommand)。
 *
 * App 挂载时就订阅 `extensionsChanged`、每帧读 `extensionStatus`,命令菜单读
 * `extensionCommands`。**这里必须列全 App 真正读到的每一个成员**:假 session
 * 都是 `as unknown as Session` 断言进去的,少了这些字段编译期看不出来、运行期
 * 直接炸在 undefined 上,所以每个假 session 都得带一份。刻意不让 App 写成
 * `session.extensionsChanged?.(…)`:可选链只会把 bootstrap 真接错线的情况
 * 一起盖掉。
 */
export function stubExtensions() {
  return {
    extensionCommands: [],
    extensionStatus: [],
    extensionState: {},
    extensionsChanged: () => () => {},
    runCommand: async () => {},
    commandOptions: async () => [],
  };
}
