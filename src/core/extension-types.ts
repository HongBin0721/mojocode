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
import { palette, sgrForeground } from './palette.js';

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
export type UiRequest = {
  id: string;
  title: string;
  /** 给了 `timeout` 时的绝对到期时刻(见 ExtensionUIDialogOptions)。 */
  deadline?: number;
} & (
  | { kind: 'select'; items: string[] }
  | { kind: 'confirm'; message: string }
  | { kind: 'input'; placeholder?: string }
  /** 多行编辑框(Pi 的 `ctx.ui.editor`):回车提交,行尾 `\` + 回车换行,esc 取消。 */
  | { kind: 'editor'; prefill?: string }
);

/**
 * 提问框的选项(Pi 的 ExtensionUIDialogOptions):`timeout` 到点按「没答」兑现
 * (TUI 在提示里倒数),`signal` 中止同样按「没答」兑现。`deadline` 是宿主
 * 算好塞进 UiRequest 的绝对时刻,TUI 只管画倒计时,不自己计时。
 */
export interface ExtensionUIDialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

/** select → 选中的项(esc 为 undefined);confirm → 布尔;input / editor → 文本(esc 为 undefined)。 */
export type UiAnswer = string | boolean | undefined;

/**
 * Pi 工具 execute 的返回形状(AgentToolResult):`content` 喂模型,`details`
 * 是**只给画法用**的通道——`renderResult` 收到的是整个对象,模型只看到
 * `content` 拼成的文本(tool-adapter 用 AI SDK 的 `toModelOutput` 分流)。
 */
export interface PiToolResult {
  content: Array<{ type?: string; text?: string }>;
  details?: unknown;
}

/**
 * Pi 的内容部件(TextContent / ImageContent):工具结果、`sendUserMessage`、
 * `sendMessage` 的 content 数组都是这个形状。图片是 base64 + mimeType。
 */
export type PiContentPart = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/**
 * Pi 的 content(字符串或部件数组)里的文字部分,按行拼起来;图片部件不在其中。
 * 部件按不可信处理(扩展的工具结果没过类型检查):不是文字部件的一律跳过。
 */
export function piContentText(content: string | ReadonlyArray<{ type?: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/**
 * 扩展消息的投递方式(Pi 的 `deliverAs`):`steer` 运行中作为轮内引导(模型
 * 下一步就看到),`followUp` 等当前链条收尾后作为新的一轮,`nextTurn` 不打断
 * 也不开轮、等下一次用户提问时一并送进去。
 */
export type DeliverAs = 'steer' | 'followUp' | 'nextTurn';

/** 工具输出 → Pi 的内容部件:Pi 形状的原样取 content,其余转成一段文本。 */
export function toPiContent(output: unknown): PiContentPart[] {
  if (isPiToolResult(output)) {
    return output.content.map((part) =>
      part.type === 'image' ? (part as PiContentPart) : { type: 'text', text: part.text ?? '' },
    );
  }
  const text = output === undefined ? '' : typeof output === 'string' ? output : JSON.stringify(output);
  return [{ type: 'text', text }];
}

export function isPiToolResult(value: unknown): value is PiToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

/** Pi 的 AgentToolResult → 喂给模型的文本;不是那个形状原样返回。零依赖,时间线与适配器共用。 */
export function flattenPiResult(result: unknown): unknown {
  return isPiToolResult(result) ? piContentText(result.content) : result;
}

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

const sgr = (open: string, close: string, text: string): string =>
  text ? `\x1b[${open}m${text}\x1b[${close}m` : text;

/**
 * 那份主题的实现:纯 SGR 序列,零依赖——`ctx.ui.theme`(Pi 同名)在 headless
 * 下也拿得到同一份,组件的 `host.theme`、工具画法与回滚转储用的也是它。
 *
 * 颜色**现查 `palette`**(全产品唯一那张配色表),不是一张写死的 SGR 表:
 * 写死过一版,于是用户换了主题只有 TUI 自己的边框与文字变色,扩展画的每
 * 一行、每个 renderCall/renderResult、整段回滚转储全都还是内置色。`text`
 * 没有对应的配色键,照旧是"终端默认前景"。
 */
export const extensionTheme: ExtensionTheme = {
  fg: (name, text) => sgr(name === 'text' ? '39' : sgrForeground(palette[name]), '39', text),
  bold: (text) => sgr('1', '22', text),
  dim: (text) => sgr('2', '22', text),
  italic: (text) => sgr('3', '23', text),
};

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

/**
 * 顶替输入框的编辑器组件(Pi 的 `ctx.ui.setEditorComponent`):在 Component
 * 之上多两个可选的读写口,`getEditorText / setEditorText / pasteToEditor`
 * 在它挂着时走这里。`submit(text)` 与用户在缺省输入框回车同一条路(斜杠
 * 命令、`!` 命令、@ 引用展开照常)。
 */
export interface ExtensionEditorComponent extends ExtensionComponent {
  getText?(): string;
  setText?(text: string): void;
  /**
   * 在光标处插入(`ui.pasteToEditor` 的落点)。不实现就退化成追加到末尾
   * ——组件的光标在它自己肚子里,宿主够不着,想要"在光标处"就得自己接
   * 这一个方法。
   */
  insertText?(text: string): void;
}

export type EditorComponentFactory = (
  host: ComponentHost,
  submit: (text: string) => void,
) => ExtensionEditorComponent;

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

/** 覆盖层的锚点(Pi 的 9 个位置)。 */
export type OverlayAnchor =
  | 'center'
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'left-center'
  | 'right-center'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

/**
 * `ui.custom(…, { overlay: true, overlayOptions })` 的定位与尺寸(Pi 同名同义的
 * 子集):数字是格数,`"50%"` 按终端尺寸算;`anchor` 与 `row`/`col` 二选一
 * (给了 row/col 就按绝对位置放);`margin` 是与终端边缘的最小距离;`visible`
 * 让覆盖层在窄终端上自己让路。算法在 ui/overlay-layout.ts。
 */
export interface OverlayOptions {
  width?: number | `${number}%`;
  height?: number | `${number}%`;
  minWidth?: number;
  maxWidth?: number | `${number}%`;
  minHeight?: number;
  maxHeight?: number | `${number}%`;
  anchor?: OverlayAnchor;
  offsetX?: number;
  offsetY?: number;
  row?: number | `${number}%`;
  col?: number | `${number}%`;
  margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
  visible?: (termWidth: number, termHeight: number) => boolean;
}

/** `onHandle` 交给扩展的把手:临时藏起来 / 永久撤掉(等于以 undefined 收尾)。 */
export interface OverlayHandle {
  setHidden(hidden: boolean): void;
  hide(): void;
}

/** `ui.custom` 挂出来的一个待画组件;TUI 画它,done 之后经 resolveCustom 收尾。 */
export interface UiCustomRequest {
  id: string;
  factory: (host: ComponentHost, done: (value: unknown) => void) => ExtensionComponent;
  /**
   * 给了就是覆盖层:浮在时间线之上、不顶掉输入框(但键盘仍归它)。函数形态
   * 每次布局现取(Pi 允许动态选项)。
   */
  overlay?: OverlayOptions | (() => OverlayOptions);
  /** `handle.setHidden(true)` 之后:组件留着、只是不画。换引用不就地改,TUI 的 memo 才看得见。 */
  hidden?: boolean;
}

/** widget 放在输入框上方还是下方(Pi 的 WidgetPlacement)。缺省上方。 */
export type WidgetPlacement = 'aboveEditor' | 'belowEditor';

/**
 * 工作状态线的 spinner(Pi 的 setWorkingIndicator):`frames` 空数组 = 不画
 * spinner;单帧 = 静态标记;自定义帧原样画,颜色由扩展自己带。
 */
export interface WorkingIndicator {
  frames: string[];
  intervalMs?: number;
}

/**
 * 扩展的原始终端输入监听(Pi 的 onTerminalInput):`data` 是终端送来的原始
 * 序列,返回 `{ consume: true }` 就吞掉——TUI 的任何组件都不再收到它。
 * 没有 Pi 的 `data` 改写:OpenTUI 的输入处理器只能回答「吞不吞」,改写
 * 序列没有可挂的口。
 */
export type TerminalInputHandler = (data: string) => { consume?: boolean } | undefined | void;

/** 扩展占用的几块固定界面区域。 */
export interface UiSurfaces {
  /** 输入框上方(缺省)或下方的小部件,按 key 去重、注册顺序排列。 */
  widgets: Array<{ key: string; surface: ExtensionSurface; placement?: WidgetPlacement }>;
  /** 屏幕顶部(时间线之上)。 */
  header?: ExtensionSurface;
  /** 替换底栏。 */
  footer?: ExtensionSurface;
  /** 终端窗口标题。 */
  title?: string;
  /** 工作状态线里替换「思考中 / 回复中」的文字(Pi 的 setWorkingMessage)。 */
  workingMessage?: string;
  /** 顶替缺省输入框的编辑器组件工厂(Pi 的 setEditorComponent)。 */
  editor?: EditorComponentFactory;
  /** 只在扩展 `setWorkingVisible(false)` 时存在(值为 false);缺省画。 */
  workingVisible?: boolean;
  /** 工作状态线的 spinner 帧(Pi 的 setWorkingIndicator);缺省内置动画。 */
  workingIndicator?: WorkingIndicator;
  /** 折叠的思考块那一行的标签(Pi 的 setHiddenThinkingLabel);缺省「已思考 …」。 */
  hiddenThinkingLabel?: string;
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
  /** 在光标处插入(Pi 的 pasteToEditor);缺省输入框与扩展编辑器都认。 */
  pasteToEditor?(text: string): void;
  /**
   * 退出界面(`ctx.shutdown`):与双 ctrl+c 同一条路——卸载 App、转储时间线、
   * CLI 收尾。与另外三个可选成员不同,这一个**没有可退化的缺省**:不实现就等于
   * `ctx.shutdown()` 在这个宿主上无声失效。可选只是为了测试里的假宿主能只写
   * `{ available }`;真正在渲染界面的宿主都该实现它。
   */
  exit?(): void;
  /** ctrl+r 的详情开关(思考正文、工具输出),扩展经 `ui.getToolsExpanded / setToolsExpanded` 读写。 */
  getToolsExpanded?(): boolean;
  setToolsExpanded?(expanded: boolean): void;
  /**
   * 配色表已被 `ui.setTheme` 就地改过(core 的 applyPalette):TUI 让读过
   * `theme.x` 的节点重算,并改盯 `file`(undefined = 没有文件可盯)。
   */
  themeChanged?(file: string | undefined): void;
}

/** 扩展经 sendMessage 放进对话的一条自定义消息(时间线与回放都用它)。 */
export interface CustomMessageInfo {
  customType: string;
  content: string;
  /** Pi 的 `details`:只给画法用,不进持久历史(`/resume` 回放时没有)。 */
  details?: unknown;
  /** 时间线展示用的替代文本;缺省画 content。 */
  display?: string;
}

/**
 * `sendMessage` 的入参(Pi 的 CustomMessage 去掉宿主填的字段),before_agent_start
 * 返回的 `message` 也是它:`content` 可以是 Pi 的部件数组(只取文字部分);
 * `display` 为 false 时进对话但不上时间线,为字符串时是时间线上的替代文本;
 * `details` 交给 registerMessageRenderer。
 */
export interface SendMessageInput {
  customType: string;
  content: string | PiContentPart[];
  display?: boolean | string;
  details?: unknown;
}

/** 宿主内部的自定义消息:content 已拍成文字,Pi 的 `display: false` 换成 `hidden`。 */
export interface CustomMessage extends CustomMessageInfo {
  hidden?: boolean;
}

/** Pi 形状 → 宿主形状。sendMessage 与 before_agent_start 的 message 共用这一处翻译。 */
export function fromPiMessage(message: SendMessageInput): CustomMessage {
  return {
    customType: message.customType,
    content: piContentText(message.content),
    ...(typeof message.display === 'string' ? { display: message.display } : {}),
    ...(message.display === false ? { hidden: true } : {}),
    ...(message.details !== undefined ? { details: message.details } : {}),
  };
}

/** 自定义消息在时间线里的画法(Pi 的 registerMessageRenderer,只认字符串行)。 */
export type MessageRenderer = (message: CustomMessageInfo, theme: ExtensionTheme) => string[] | undefined;
