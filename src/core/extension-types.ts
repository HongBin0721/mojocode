/**
 * 扩展 API 里 TUI 直接消费的那几个纯数据类型(命令表投影、状态行、工具
 * 作用域、提问请求)。
 *
 * 单独成文件:它们是零依赖的纯类型,TUI 的组件与 timeline-data 这类
 * Node-free 模块可以直接 import;`extension.ts` 原样 re-export,扩展作者仍然
 * 只从它一处 import。
 */

/**
 * `Session.extensionState` 里的 key。**它是扩展与 TUI 之间的契约,不是扩展
 * 的内部细节**:发布方是扩展,消费方是 TUI 的渲染组件,两方必须认同
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
   * 所以不进这份投影,由 UI 按需调 `commandOptions` 现取。
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
 * 扩展贴在输入框上方的一行状态。text 由扩展自备图标;since 是起点时刻,
 * TUI 据此自己走秒显示已用时——每秒 setStatus 一次会让整个扩展面重算一帧,
 * 把计时留给 TUI 就没有这个开销。
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

/**
 * 扩展向用户提问(`ctx.ui.select / confirm / input`,Pi 的 `ctx.ui` 同形)。
 * 请求记进 `Session.uiRequests`(同时以 bus 事件 `ui-request` 播报给
 * headless --json 与扩展的 onEvent),TUI 弹出对应的提示框,答案经 `answerUi`
 * 送回,随后 `ui-resolved` 播报。没有前端在看(headless)时宿主立即按缺省值
 * 兑现——`hasUI` 就是这个判定。
 */
export type UiRequest =
  | { id: string; kind: 'select'; title: string; items: string[] }
  | { id: string; kind: 'confirm'; title: string; message: string }
  | { id: string; kind: 'input'; title: string; placeholder?: string };

/** select → 选中的项(esc 为 undefined);confirm → 布尔;input → 文本(esc 为 undefined)。 */
export type UiAnswer = string | boolean | undefined;

/**
 * 扩展渲染层(Pi 的 Component / setWidget / renderCall 那一族)。扩展与 TUI
 * 同进程,所以扩展可以直接交一个「渲染成行、可选处理按键」的对象给界面;
 * 核心不认识 SolidJS,这里只是纯数据与函数形状,画出来是 TUI 的事。
 */

/** 按键的解析结果(与 TUI kit 的 Key 同形,核心不 import UI)。 */
export interface ExtensionKey {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageUp: boolean;
  pageDown: boolean;
  return: boolean;
  escape: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

/** 给扩展上色的最小主题面:返回带 ANSI 的字符串,TUI 原样解析。 */
export interface ExtensionTheme {
  fg(name: 'accent' | 'dim' | 'error' | 'warn' | 'success' | 'text', text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  italic(text: string): string;
}

/**
 * Pi 的 Component 同形:`render(width)` 给出要画的行(可带 ANSI),
 * `handleInput` 收按键——`data` 是 Pi 风格的原始序列(可打印字符原样、
 * esc 为 `\x1b`、回车 `\r`、方向键为 CSI 序列),`key` 是解析结果,二选一用。
 * 只有 `ui.custom` 挂出来的组件收得到按键;widget / header / footer 只画。
 */
export interface ExtensionComponent {
  render(width: number): string[];
  handleInput?(data: string, key: ExtensionKey): void;
}

/** 组件的宿主:要求重画、当前宽度、主题。 */
export interface ComponentHost {
  requestRender(): void;
  readonly width: number;
  readonly theme: ExtensionTheme;
}

export type ComponentFactory = (host: ComponentHost) => ExtensionComponent;

/** widget / header / footer 的内容:一组行,或一个按需重画的组件工厂。 */
export type ExtensionSurface = string[] | ComponentFactory;

/** 工具在时间线里的自定义画法(Pi 的 renderCall / renderResult,只认字符串行)。 */
export interface ToolRenderers {
  /** 调用行:替换缺省的「工具名(参数)」;返回 undefined 用缺省。 */
  renderCall?(input: unknown, theme: ExtensionTheme): string[] | undefined;
  /** 结果块:替换缺省的摘要/差异/输出;返回 undefined 用缺省。 */
  renderResult?(
    output: unknown,
    options: { isError: boolean; expanded: boolean; input: unknown },
    theme: ExtensionTheme,
  ): string[] | undefined;
}

/** `ui.custom` 挂出来的一个待画组件;TUI 画它,done 之后经 resolveCustom 收尾。 */
export interface UiCustomRequest {
  id: string;
  factory: (host: ComponentHost, done: (value: unknown) => void) => ExtensionComponent;
}

/** 扩展占用的几块固定界面区域。 */
export interface UiSurfaces {
  /** 输入框上方的小部件,按 key 去重、注册顺序排列。 */
  widgets: Array<{ key: string; surface: ExtensionSurface }>;
  /** 屏幕顶部(时间线之上)。 */
  header?: ExtensionSurface;
  /** 替换底栏。 */
  footer?: ExtensionSurface;
  /** 终端窗口标题。 */
  title?: string;
}

/**
 * 快捷键规范:`[ctrl+][meta+][shift+]<键>`,键是单个字母/数字或
 * `up` / `down` / `left` / `right` / `tab` / `escape` / `return` / `backspace` /
 * `delete` / `pageup` / `pagedown`。修饰键顺序、大小写、`alt` 与 `meta` 的
 * 别名都在这里归一,注册方与派发方(TUI 从按键还原)拼出同一个字符串。
 * 只认带 ctrl 或 meta 的组合——不带修饰键的字符是在打字,不是快捷键。
 */
export function normalizeShortcut(spec: string): string {
  const parts = spec.toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  const mods = new Set<string>();
  let key = '';
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') mods.add('ctrl');
    else if (part === 'meta' || part === 'alt' || part === 'option' || part === 'cmd') mods.add('meta');
    else if (part === 'shift') mods.add('shift');
    else key = part === 'esc' ? 'escape' : part === 'enter' ? 'return' : part;
  }
  return [...['ctrl', 'meta', 'shift'].filter((m) => mods.has(m)), key].join('+');
}

/**
 * TUI 自己占着的组合键,扩展注册不上(`registerShortcut` 直接抛错)。
 * 住在核心而不是 TUI:注册是在核心做的,错误要在**注册那一刻**报出来,
 * 而不是等用户按下去发现没反应。App 的键盘处理器把扩展派发排在这几个
 * 分支之后,是第二道防线——两道都要有:光靠顺序,一个注册了 ctrl+c 的
 * 扩展仍会让用户以为自己的快捷键坏了。
 */
export const RESERVED_SHORTCUTS = new Set([
  // App 的全局键。
  'ctrl+c',
  'ctrl+t',
  'ctrl+o',
  'ctrl+r',
  // 输入框的 readline 绑定(Input.tsx)。它们与 App 的处理器是两个独立的
  // 订阅者,不列进来的话扩展注册 ctrl+a 会与「跳到行首」同时触发。
  'ctrl+a',
  'ctrl+e',
  'ctrl+u',
  'ctrl+k',
  'ctrl+w',
  'ctrl+v',
  'ctrl+j',
]);

/** 扩展注册的快捷键在菜单/帮助里的投影。 */
export interface ExtensionShortcutInfo {
  key: string;
  description: string;
}

/**
 * TUI 挂上会话时交给核心的一组回调(`Session.attachUi`):有没有人在看、
 * 读写输入框草稿。headless 从不挂——提问按缺省兑现,编辑框读到空串。
 */
export interface UiHost {
  available(): boolean;
  getEditorText?(): string;
  setEditorText?(text: string): void;
}

/** 扩展经 sendMessage 放进对话的一条自定义消息(时间线与回放都用它)。 */
export interface CustomMessageInfo {
  customType: string;
  content: string;
  /** 时间线展示用的替代文本;缺省画 content。 */
  display?: string;
}

/** 自定义消息在时间线里的画法(Pi 的 registerMessageRenderer,只认字符串行)。 */
export type MessageRenderer = (message: CustomMessageInfo, theme: ExtensionTheme) => string[] | undefined;
