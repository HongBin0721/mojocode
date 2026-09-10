/**
 * 扩展 API(Pi 的 ExtensionAPI 的 mojocode 版):功能从核心搬出去之后与宿主
 * 打交道的**唯一**面。扩展只拿这个对象,不碰 Session / Agent / Store 本体。
 * 面窄是有意的:每个成员都由一次真实的拆分逼出来(第一个是 /goal),不照
 * Pi 的清单空写一遍。
 *
 * 一方扩展静态打包(src/extensions/index.ts),磁盘扩展由 extensions/loader.ts
 * 三层发现(包 / 全局目录 / 项目目录 / `-e`),bootstrap 逐个 setup,两者拿的是
 * 同一份 API。扩展跑在**会话进程**(受管的 serve 子进程)
 * 里:命令表与状态行经 StateSnapshot 过线到 TUI/GUI,用户可见的提示走 bus
 * 的 notice(文案在会话进程按其语言本地化,与 MCP 失败提示同一条路)。
 */

import type { LanguageModel, ModelMessage, Tool } from 'ai';
import type { AgentEvent } from './events.js';
import type { HookRegistry } from './hooks.js';
import type { Config } from '../config/schema.js';
import type { SessionCustomRecord } from '../session/store.js';
import type { ImageAttachment } from '../app/attachments.js';
// 过线的那几个类型住在 Node-free 的 extension-types.ts,理由见那边的文件头;
// 这里原样 re-export,扩展作者仍然只从 core/extension.js 一处 import。
import type {
  ExtensionCommandInfo,
  ExtensionCommandOption,
  ExtensionStatusEntry,
  ToolScope,
} from './extension-types.js';

export type { ExtensionCommandInfo, ExtensionCommandOption, ExtensionStatusEntry, ToolScope };

export interface ExtensionRunOptions {
  display?: string;
  images?: ImageAttachment[];
}

/** 返回 undefined = 这个作用域里不提供该工具(如 explore 不给有副作用的工具)。 */
export type ExtensionToolFactory = (scope: ToolScope) => Tool | undefined;

export interface ExtensionCommand {
  description: string;
  argumentHint?: string;
  /** 选择器框标题;缺省用 `/name`。 */
  selectorTitle?: string;
  /**
   * 取值选择器:给了它,命令在菜单上回车会先让用户选,选中的 value 作为
   * `args` 再调 handler。每次打开现取——档位要标出当前生效的那个,分支
   * 列表要跑 git,静态快照会过期。
   *
   * `path` 是**已经选过的层**(第一层为空数组)。返回项标了 `expands` 就
   * 会带着 `[...path, value]` 再问一次,层数不限;最终提交给 handler 的
   * `args` 是各层 value 以空格连接——所以 `/review` 的 handler 收到的仍是
   * `base main` 这种它本来就认识的字符串,选择器只是它的一种输入方式。
   * 某一层返回空表时客户端提交 `/name <path...>`,由 handler 自己解释
   * "这一层没有可选项"(是没有分支,还是根本不是 git 仓库)。
   */
  options?: (path: string[]) => ExtensionCommandOption[] | Promise<ExtensionCommandOption[]>;
  /**
   * 处理器。它是**即时 RPC**(不是 deferred):要发起一轮就 `followUp` /
   * `void run(...)`,不要 await 一整轮——挂在 HTTP 请求上会撞各层超时;
   * 忙不忙由扩展自己判(`isRunning`),客户端不替它拦——`/goal clear` 正是
   * 循环跑着的时候才要用的。
   *
   * 只收 args。曾经还带一个 `{ raw }`(用户敲的原文)做 display 用,但没有
   * 一个扩展读它——`/review` 甚至自己重拼了一份 display 串——而它要一路穿过
   * handler 签名、Session、remote、serve、IPC 的 wire 字段与两个前端的构造
   * 点。这一层的原则是「每个成员都由一次真实的拆分逼出来」,真有扩展要用户
   * 的字面文本时再加回来。
   */
  handler: (args: string) => void | Promise<void>;
}

export interface ExtensionAPI {
  readonly id: string;
  /** 工作区根目录(绝对路径)。 */
  readonly root: string;
  /** 注册钩子(core/hooks.ts),返回注销函数。 */
  on: HookRegistry['on'];
  /** 只读订阅 bus 的事实流(step-end 记账之类)。 */
  onEvent(handler: (event: AgentEvent) => void): () => void;
  registerCommand(name: string, command: ExtensionCommand): void;
  /**
   * 注册(或替换)一个模型可调用的工具。主 agent 的工具集是**就地改键**的
   * ——它与运行中的 Agent 共享引用,下一次开流生效;子 agent 的工具集每次
   * 现建,注册即刻生效。名字冲突时后注册的赢,内置工具不可覆盖。
   */
  registerTool(name: string, factory: ExtensionToolFactory): void;
  unregisterTool(name: string): void;
  /** 状态行;undefined 清除。 */
  setStatus(text: string | undefined, options?: { since?: number }): void;
  /**
   * 发布一份**结构化状态**给客户端(TUI / GUI):它随 `StateSnapshot` 过线,
   * 客户端从 `extensionState[key]` 同步读,变化经 `extensionsChanged` 通知。
   * `undefined` 清除该键。
   *
   * 与另外两个「对外说话」的成员分工,别混:
   * - `setStatus` 是**一行给人看的文字**,客户端原样贴在输入框上方,不解释;
   * - `setState` 是**数据**,客户端有专门的组件按 key 渲染(todo 清单就是这样);
   * - `publishRuntime` **不过线**,只给宿主进程内的功能(目前只有 `/doctor`)。
   *
   * 值必须可 JSON 序列化,且要小——它随每一帧快照过线,进 `snapshotKey` 的
   * 变化检测。大块内容(技能正文、工具输出)永远走别的通道。
   */
  setState(key: string, value: unknown): void;
  /** 用户可见的一条提示(时间线 notice)。 */
  notify(level: 'info' | 'warn', message: string): void;
  /**
   * 把一份会话内的运行时快照挂给宿主。目前唯一的消费方是 `/doctor`:它对
   * 「会话里已经拉起来的子进程」有则采信、不再自己拉一份(LSP 的语言服务器、
   * MCP 的 stdio server 都是这个形状)。传的是 getter,读时现取。
   *
   * key 由扩展与宿主约定(宿主按 key 断言类型),值绝不过线——它描述的是
   * 会话进程里的活物,序列化给客户端没有意义。
   */
  publishRuntime(key: string, get: () => unknown): void;
  /** 发起一整轮(链条),与 Agent.run 同语义:运行中退化为轮内引导。 */
  run(text: string, options?: ExtensionRunOptions): Promise<void>;
  /** 轮后续跑:当前链条收尾后作为新一轮开跑;空闲时立即开跑。 */
  followUp(text: string, options?: ExtensionRunOptions): void;
  isRunning(): boolean;
  abort(): void;
  /** 模型历史(压缩后是摘要 + 尾巴)。 */
  history(): ModelMessage[];
  /** 会话记录里追加一条自定义记录(kind custom);随会话分叉、随 /resume 读回。 */
  appendEntry(type: string, data: unknown): Promise<void>;
  /** 当前会话的自定义记录(写入顺序)。 */
  entries(type: string): SessionCustomRecord[];
  /** 会话配置,按引用:/think 之类的就地修改现读现得。 */
  readonly config: Config;
  /** 当前 provider 的模型;给 modelId 用同一 provider 换个模型(评估器、便宜模型)。 */
  model(modelId?: string): LanguageModel;
}

export interface Extension {
  /** 稳定 id:状态行按它去重,日志/提示里点名它,`disabledExtensions` 按它跳过。 */
  id: string;
  /**
   * 装配。一方扩展是同步的;磁盘扩展(`~/.mojocode/extensions/*.ts`、包)
   * 可以是 async——bootstrap 按顺序逐个 await,失败变成一条 startup notice,
   * 绝不拖垮会话。
   */
  setup(api: ExtensionAPI): void | Promise<void>;
}

/**
 * 磁盘扩展模块的导出形状(Pi 式):`export default (api) => { … }`。也接受
 * `export default { id?, setup }`——id 缺省从文件名推(`foo.ts` → `foo`,
 * `foo/index.ts` → `foo`,包里的再冠以 `<包名>/`)。见 extensions/loader.ts。
 */
export type ExtensionModuleExport = ((api: ExtensionAPI) => void | Promise<void>) | Partial<Extension>;
