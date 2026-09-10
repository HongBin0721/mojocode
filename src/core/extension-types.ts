/**
 * 扩展 API 里**会过线**的那几个类型(命令表投影、状态行、工具作用域)。
 *
 * 单独成文件是有原因的:`extension.ts` 为了描述完整的 ExtensionAPI 必须
 * import `session/store.js`(custom 记录)与 `app/attachments.js`(图片附件),
 * 两者都是 Node 代码;而 `server/protocol.ts` 是纯 wire 类型模块,又是 GUI
 * renderer 的 `@core/protocol` 白名单入口——renderer 的 tsconfig 没有 node
 * 类型,那条链一接上就整片报错。所以过线的类型住在这里(零依赖),
 * `extension.ts` 原样 re-export,扩展作者仍然只从它一处 import。
 */

/**
 * `StateSnapshot.extensions.state` 里的 key。**它是过线契约,不是扩展的
 * 内部细节**:发布方是扩展,消费方是两个前端各自的渲染组件,三方必须认同
 * 同一个字符串。放在这里(而不是扩展的实现模块里)有两个理由——TUI 里
 * 只为一个常量静态 import `extensions/todo/index.ts` 会把 ai + zod 整个拉进
 * TUI chunk;而 GUI renderer 够不着扩展模块,只能手写字面量,写错了编译期
 * 没人拦。
 */
export const TODO_STATE_KEY = 'todo';

/** 斜杠命令在客户端菜单里的投影(只有元数据;执行走 runCommand)。 */
export interface ExtensionCommandInfo {
  name: string;
  description: string;
  /** 菜单里跟在描述后面的参数提示,如 `<condition> | clear`。 */
  argumentHint?: string;
  /**
   * 有取值选择器:在命令菜单上回车会先进二级选择器,而不是直接执行。
   * 取值本身是**动态**的(档位要标出当前生效的那个、分支列表要跑 git),
   * 所以不随快照过线,由客户端按需走 `commandOptions` RPC 现取。
   */
  hasOptions?: boolean;
  /** 选择器框标题;缺省用 `/name`。 */
  selectorTitle?: string;
}

/** 二级选择器里的一项。字段语义与 TUI 的 CommandOption 一致(它就是投影)。 */
export interface ExtensionCommandOption {
  /** 提交给命令的参数值。 */
  value: string;
  /** 两行渲染时的标题行;给了它 value 就不再展示(预设的 value 是机器串)。 */
  title?: string;
  /** 说明文字;两行渲染时作描述行。 */
  label?: string;
  /** 当前生效的值——打开选择器时预选,并带 ✓ 标记。 */
  current?: boolean;
  /**
   * 选中它是**再开一层**,不是提交:客户端拿 `[...path, value]` 再要一次
   * `commandOptions`。`/review` 的 base / commit 就是这种——先选"跟哪个
   * 基准比",再从现算的分支/提交列表里挑一个。层数不设上限,esc 逐层退回。
   */
  expands?: boolean;
  /**
   * 选中它是**预填输入框**(`/name <path...> `,带尾随空格),让用户接着
   * 补自由文本。`/review custom` 要的是一句焦点说明,那不是能从列表里挑
   * 出来的东西;没有它,自由文本参数的命令就只能退化成让用户自己记语法。
   */
  prefill?: boolean;
}

/**
 * 扩展贴在输入框上方的一行状态。text 由扩展自备图标;since 是会话进程的
 * 时钟,客户端据此自己走秒显示已用时——每秒 setStatus 一次会变成每秒一帧
 * 状态推送,把计时留给客户端就没有这个开销。
 */
export interface ExtensionStatusEntry {
  id: string;
  text: string;
  since?: number;
}

/**
 * 要工具集的是哪一类 agent。扩展注册的是**工厂**而不是工具本身,就为了让它
 * 按作用域自己决定给不给、怎么给——explore 子 agent 只拿只读工具就是这么实现的
 * (MCP 工具不透明、可能有副作用,它的工厂在 explore 下直接返回 undefined)。
 */
export interface ToolScope {
  /** 子 agent(task 工具 / fork 技能)。 */
  subagent: boolean;
  /** 子 agent 的类型;主 agent 不传。explore 是只读调研。 */
  mode?: 'general' | 'explore';
}
