/**
 * 渲染器适配层:以 Ink 的 API 形状(Box/Text/useInput/useApp/render)包装
 * OpenTUI 的 @opentui/solid。
 *
 * 存在的理由有二:
 * 1. 迁移面收敛——UI 组件只面对这一层稳定 API,JSX 结构与键盘逻辑跨框架
 *    (React → Solid)迁移时基本原样保留;
 * 2. 上游隔离——OpenTUI 还在 0.x,破坏性变更只需改这一个文件。
 *
 * 与 Ink 的语义差异,均已在此抹平:
 * - OpenTUI 的 <text> 不解析 ANSI(T0 探针①):Text 检测到子串含 ESC 时
 *   经 parseAnsiSpans 转成 <span> 段;SGR 39/49 恢复为「继承外层」,与
 *   chalk 的嵌套行为一致(Diff 背景高亮依赖)。
 * - 嵌套 <Text> 在 OpenTUI 里必须是 <span>(上游 #438):以 context 判定
 *   自身层级自动切换。
 * - Yoga 裸默认与 Ink 不同:Ink 的 Box 默认 flexDirection="row"、
 *   flexShrink=1,此处补齐同样的默认值,否则既有布局全部错位。
 * - OpenTUI 把一个 stdin chunk 拆成逐字符 keypress 同步连发:普通字符在
 *   同一个微任务内累积、批尾一次性派发(见 useInput)。React 时代这还救过
 *   「旧闭包覆盖前字」的丢字 bug;Solid 的处理器读的是信号当前值,没有
 *   旧闭包问题,但合并派发仍把 N 次重渲染收敛成一次,保留。
 *
 * Solid 纪律(改这层时牢记):组件内**不解构 props**(会断开响应式追踪),
 * JSX 里内联访问 `props.x`;需要成组传递时用 createMemo 包对象再 spread。
 */
import {
  createCliRenderer,
  decodePasteBytes,
  TextAttributes,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent as OtuiMouseEvent,
} from '@opentui/core';
import {
  render as solidRender,
  useKeyboard,
  usePaste,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
  type JSX,
} from '@opentui/solid';
import { createContext, createMemo, children as resolveChildren, onCleanup, splitProps, useContext } from 'solid-js';
import { hasAnsi, parseAnsiSpans, type AnsiSpan } from './ansi-spans.js';
import { writeClipboardText } from '../app/clipboard.js';

export type { JSX };

// ---------------------------------------------------------------------------
// 键盘:Ink useInput 的形状
// ---------------------------------------------------------------------------

/** Ink `useInput` 回调的 key 对象(仅含本项目用到的字段 + 常用补充)。 */
export interface Key {
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

function emptyKey(): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageUp: false,
    pageDown: false,
    return: false,
    escape: false,
    tab: false,
    backspace: false,
    delete: false,
    ctrl: false,
    shift: false,
    meta: false,
  };
}

/** 纯修饰键与窗口事件,不派发给 useInput。 */
const IGNORED_KEYS = new Set([
  'shift', 'ctrl', 'alt', 'meta', 'super', 'hyper', 'capslock', 'numlock',
  'insert', 'menu', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
]);

const NAME_TO_FLAG: Record<string, keyof Key> = {
  up: 'upArrow',
  down: 'downArrow',
  left: 'leftArrow',
  right: 'rightArrow',
  pageup: 'pageUp',
  pagedown: 'pageDown',
  return: 'return',
  enter: 'return',
  escape: 'escape',
  tab: 'tab',
  backspace: 'backspace',
  delete: 'delete',
};

/** KeyEvent → Ink (input, key)。返回 undefined 表示丢弃该事件。 */
export function mapKeyEvent(event: KeyEvent): { input: string; key: Key } | undefined {
  if (event.eventType === 'release') return undefined;
  const name = event.name ?? '';
  if (IGNORED_KEYS.has(name)) return undefined;

  const key = emptyKey();
  key.ctrl = event.ctrl;
  key.shift = event.shift;
  key.meta = event.meta || event.option || Boolean(event.super);

  // ctrl+j(legacy 下是裸 \n):Ink 报告为 input 'j' + ctrl,Input.tsx 的
  // 换行 fallback 依赖这一形状。
  if (name === 'linefeed') {
    key.ctrl = true;
    return { input: 'j', key };
  }

  const flag = NAME_TO_FLAG[name];
  if (flag) {
    key[flag] = true;
    return { input: '', key };
  }

  if (name === 'space') return { input: ' ', key };

  // 可打印字符(含 CJK):带 ctrl/meta 时 sequence 可能是控制字节,用 name;
  // 否则用 sequence(kitty 下 name 是基础布局字符,sequence 才是实际输入)。
  const input = key.ctrl || key.meta ? name : event.sequence || name;
  if (input === '' || input.includes('\x1b')) return undefined;
  return { input, key };
}

export interface UseInputOptions {
  /** 布尔或访问器:Solid 下传信号访问器,每个事件到达时现取现判。 */
  isActive?: boolean | (() => boolean);
}

/** 是否为可合并的普通输入(无任何特殊键标志、无 ctrl/meta;shift 允许,大写)。 */
function isPlainInput(input: string, key: Key): boolean {
  if (input === '' || key.ctrl || key.meta) return false;
  return !(
    key.upArrow || key.downArrow || key.leftArrow || key.rightArrow ||
    key.pageUp || key.pageDown || key.return || key.escape || key.tab ||
    key.backspace || key.delete
  );
}

/**
 * Ink useInput 等价物。与 Ink 相同:所有活跃回调都收到每个按键(手工互斥
 * 的焦点模型依赖这一点);粘贴文本(bracketed paste)按 Ink 语义合并为
 * 一次大 input 派发。
 *
 * 同一批到达的普通字符在微任务内累积、批尾一次性派发;特殊键到达时先冲刷
 * 累积再派发,顺序不乱。Solid 的信号更新是同步的,处理器读的永远是当前值,
 * React 时代的 flushSync 强制提交不再需要。
 */
export function useInput(
  handler: (input: string, key: Key) => void,
  options: UseInputOptions = {},
): void {
  const isActive = (): boolean => {
    const active = options.isActive;
    if (typeof active === 'function') return active();
    return active !== false;
  };
  let pending = '';
  let flushQueued = false;

  const flush = (): void => {
    flushQueued = false;
    if (pending === '') return;
    const merged = pending;
    pending = '';
    handler(merged, emptyKey());
  };

  useKeyboard((event) => {
    if (!isActive()) return;
    const mapped = mapKeyEvent(event);
    if (!mapped) return;
    if (isPlainInput(mapped.input, mapped.key)) {
      pending += mapped.input;
      if (!flushQueued) {
        flushQueued = true;
        queueMicrotask(flush);
      }
      return;
    }
    flush(); // 特殊键先冲刷已累积的普通字符,保持派发顺序
    handler(mapped.input, mapped.key);
  });

  usePaste((event) => {
    if (!isActive()) return;
    const text = decodePasteBytes(event.bytes);
    if (text.length === 0) return;
    flush();
    handler(text, emptyKey());
  });
}

// ---------------------------------------------------------------------------
// 鼠标:点击与滚轮
// ---------------------------------------------------------------------------

/** 滚轮方向。横向滚轮(left/right)本项目用不到,不往上暴露。 */
export type ScrollDirection = 'up' | 'down';

/** 点击信息。x/y 是终端格坐标(左上角为 0,0)。 */
export interface ClickInfo {
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/**
 * 指针状态,**按渲染器共享一份**(而不是每个可点击元素各存一份)。
 *
 * 各存一份会漏状态:按下落在 A、拖走后在别处抬起,A 永远等不到自己的那次
 * up,按下坐标就一直武装着;之后任何**结束**在同一格的拖动(比如反向划一次
 * 选区)都会被 A 判成点击。在授权确认框里那就是凭空放行一次。一个渲染器只有
 * 一个指针、同一时刻只有一次按下,共享一份才是事实本身。
 *
 * 挂在渲染器上而不是模块上,是因为测试会在同一进程里先后建多个渲染器——模块
 * 级的话,上一个渲染器留下的 lastClickAt 会让下一个界面的第一次点击落进落定
 * 窗口被吞掉。
 */
interface PointerState {
  /** 上一次按下的格子。 */
  downX: number;
  downY: number;
  /**
   * 上一次生效点击的时刻,与"落定窗口"配合使用。
   *
   * 点击常常会换掉屏幕上同一片格子的内容(点设置面板的「语言」进二级,语言
   * 列表就铺在刚才那几行上;点底栏档位弹出选项框同理)。双击的第二下于是落在
   * 第一下刚变出来的行上并立刻生效——双击「语言」= 静默把界面切成列表里那
   * 一项。凡是在上一次点击之后才挂载的元素,这段时间内不接受点击。
   */
  lastClickAt: number;
}

const CLICK_SETTLE_MS = 250;
const pointerStates = new WeakMap<CliRenderer, PointerState>();

function pointerStateOf(renderer: CliRenderer): PointerState {
  let state = pointerStates.get(renderer);
  if (!state) {
    state = { downX: -1, downY: -1, lastClickAt: 0 };
    pointerStates.set(renderer, state);
  }
  return state;
}

/**
 * 点击判定:按下与抬起落在**同一格**才算一次点击。
 *
 * 这个"零位移"的严格标准是必须的,不能放宽成"落在同一行/同一元素":
 * OpenTUI 的选择层在 <text> 上按下就开始拖选(useSelectionCopy 依赖它),
 * 用户横向划过一行去复制文字时,按下和抬起都落在这一行——一旦按元素判定,
 * 复制一段文本就顺手把这一行"点"了。
 *
 * 只认左键(button 0);滚轮在上游是 scroll 事件,不走这里。
 */
function clickHandlers(
  renderer: CliRenderer,
  onClick: () => ((info: ClickInfo) => void) | undefined,
) {
  // 组件 setup 期即挂载时刻(Solid 同步创建组件树)。
  const mountedAt = Date.now();
  const state = pointerStateOf(renderer);
  return {
    handleDown(event: OtuiMouseEvent): void {
      if (event.button !== 0) return;
      // 同一个事件对象会沿父链冒泡,嵌套的可点击元素写的是同一份坐标,重复
      // 赋值无副作用。
      state.downX = event.x;
      state.downY = event.y;
    },
    handleUp(event: OtuiMouseEvent): void {
      if (event.button !== 0) return;
      const hit = event.x === state.downX && event.y === state.downY;
      state.downX = -1;
      state.downY = -1;
      if (!hit) return;
      // 内层消费掉的点击不再冒泡:嵌套的可点击元素里应当只有最内层生效。
      // 落定窗口内也要吞:这一下已经"用掉"了,不该再穿透给外层。
      event.stopPropagation();
      const now = Date.now();
      if (mountedAt >= state.lastClickAt && now - state.lastClickAt < CLICK_SETTLE_MS) return;
      state.lastClickAt = now;
      onClick()?.({ x: event.x, y: event.y, ...event.modifiers });
    },
  };
}

/**
 * 滚轮事件的公共实现。一次事件走一步,不看 delta:终端每格一个事件,
 * 按 delta 放大只会让列表一滚就飞过去。
 */
function scrollHandler(onScroll: () => ((direction: ScrollDirection) => void) | undefined) {
  return (event: OtuiMouseEvent): void => {
    const direction = event.scroll?.direction;
    if (direction !== 'up' && direction !== 'down') return;
    // 消费掉,不再冒泡给外层的滚动容器(否则滚菜单会顺带滚动时间线)。
    event.stopPropagation();
    onScroll()?.(direction);
  };
}

// ---------------------------------------------------------------------------
// 选择复制
// ---------------------------------------------------------------------------

/**
 * 拖选自动复制(tmux copy-on-select 风格)。
 *
 * TUI 接管鼠标后终端原生拖选失效——这是滚轮滚动的固有代价。OpenTUI 自带
 * 应用内选择层(拖动时自己画高亮),这里在选择稳定后把选中文本写进剪贴板:
 * 本地经系统命令(pbcopy/wl-copy/xclip/clip),同时发 OSC 52 序列兜底——
 * SSH 场景下系统命令写的是远端的"剪贴板",真正到达本机的是 OSC 52。
 *
 * 选择事件在拖动过程中连续触发,以 300ms 静默期判定"选完了"(等 mouse-up
 * 语义,不依赖上游事件的 isDragging 时序);同一段文本只复制一次。
 *
 * @param onCopied 复制完成回调(字符数),App 用它在 footer 回显。
 * @param writer  测试注入用的写入实现,缺省走系统剪贴板。
 */
export function useSelectionCopy(
  onCopied?: (chars: number) => void,
  writer: (text: string) => Promise<boolean> = writeClipboardText,
): void {
  const renderer = useRenderer();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastCopied = '';

  useSelectionHandler((selection) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const text = selection.getSelectedText();
      if (!text || text === lastCopied) return;
      lastCopied = text;
      void writer(text).finally(() => {
        try {
          renderer.copyToClipboardOSC52(text);
        } catch {
          // OSC 52 只是兜底,失败(如测试渲染器)不影响主路径。
        }
        onCopied?.(text.length);
      });
    }, 300);
  });

  // 卸载时清掉未触发的复制定时器(同 App 的定时器纪律:进程要能干净退出)。
  onCleanup(() => {
    if (timer) clearTimeout(timer);
  });
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

export function useApp(): { exit: () => void } {
  const renderer = useRenderer();
  return { exit: () => void renderer.destroy() };
}

/**
 * 终端尺寸。返回**getter 对象**,不可解构——Solid 的响应式靠属性访问追踪,
 * `const { columns } = useTerminalSize()` 拿到的是定格的数字,resize 后
 * 永远不更新。用法:`const size = useTerminalSize()`,JSX/计算里 `size.columns`。
 */
export function useTerminalSize(): { readonly columns: number; readonly rows: number } {
  const dimensions = useTerminalDimensions();
  return {
    get columns() {
      return dimensions().width;
    },
    get rows() {
      return dimensions().height;
    },
  };
}

export interface RenderInstance {
  waitUntilExit: () => Promise<void>;
  unmount: () => void;
  renderer: CliRenderer;
}

/**
 * Ink render() 等价物(异步:原生渲染器初始化)。alternate screen 全屏;
 * exitOnCtrlC 默认关闭以保住 App 的双 ctrl+c 逻辑(启动期的向导/选择器
 * 显式打开它);destroy 即退出(还原主屏),waitUntilExit 随之 resolve。
 *
 * 与 React 版的差别:节点是 `() => JSX.Element` 惰性工厂(Solid 组件树在
 * render 内部的响应式 root 里创建)。
 */
export async function render(
  node: () => JSX.Element,
  options: { exitOnCtrlC?: boolean } = {},
): Promise<RenderInstance> {
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const renderer = await createCliRenderer({
    exitOnCtrlC: options.exitOnCtrlC ?? false,
    onDestroy: () => resolveExit(),
  });
  await solidRender(node, renderer);
  return {
    waitUntilExit: () => exited,
    unmount: () => void renderer.destroy(),
    renderer,
  };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** true = 已处于某个 <Text> 内部,再嵌套要渲染成 <span>。 */
const NestedText = createContext(false);

export interface TextProps {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dimColor?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
  /** Ink 的 wrap;本项目只用到 'truncate-end'(默认折行)。 */
  wrap?: 'wrap' | 'truncate-end';
  /**
   * 左键单击(判定见 clickHandlers)。列表面板的"点哪行选哪行"就挂在这里:
   * 列容器里的 <text> 被 Yoga 拉满整行宽(alignItems 默认 stretch),所以
   * 整行——包括文字右侧的空白——都是命中区,不必额外套一层 Box。
   *
   * **嵌套的 <Text> 渲染成 span(TextNode),不是 Renderable,不进命中网格**,
   * 挂在上面不会有任何反应;点击只能挂在行的最外层 Text 上。
   */
  onClick?: (info: ClickInfo) => void;
  children?: JSX.Element;
}

function attributesOf(props: TextProps): number {
  let attrs = 0;
  if (props.bold) attrs |= TextAttributes.BOLD;
  if (props.dimColor) attrs |= TextAttributes.DIM;
  if (props.italic) attrs |= TextAttributes.ITALIC;
  if (props.underline) attrs |= TextAttributes.UNDERLINE;
  if (props.inverse) attrs |= TextAttributes.INVERSE;
  if (props.strikethrough) attrs |= TextAttributes.STRIKETHROUGH;
  return attrs;
}

/**
 * span(TextNode)的样式**只能经 `style` prop 送达**:上游 setProperty 对
 * TextNode 只处理 href 与 style 两个键(style 里 fg/bg 走 parseColor、
 * 布尔标志走 createTextAttributes),直接的 fg=/bg=/attributes= 一律被
 * 静默忽略——症状是整段文本样式丢失、fg 落回默认白。<text> 顶层元素不受
 * 此限(走属性直写),但为一致性统一从这里构造。
 */
function spanStyle(span: AnsiSpan): Record<string, unknown> {
  return {
    ...(span.fg !== undefined ? { fg: span.fg } : {}),
    ...(span.bg !== undefined ? { bg: span.bg } : {}),
    bold: span.bold === true,
    dim: span.dim === true,
    italic: span.italic === true,
    underline: span.underline === true,
    inverse: span.inverse === true,
    strikethrough: span.strikethrough === true,
  };
}

/** 字符串子节点:含 ANSI 时拆成 <span> 段,否则原样。 */
function renderString(text: string): JSX.Element {
  if (!hasAnsi(text)) return text;
  return parseAnsiSpans(text).map((span) => <span style={spanStyle(span)}>{span.text}</span>);
}

/**
 * Text 的子节点解析。必须是**独立组件、且挂在 Provider 之内**:Solid 的
 * `children()` 助手是急切求值,若在外层 Text 的组件体里直接解析,嵌套的
 * <Text> 会在 Provider(value=true)挂载之前运行——它读到 context=false,
 * 渲染成完整的 <text> 节点,外层 text 随即拒收非 TextNode 子节点而崩。
 * (React 版没这一步:React 天然延迟到子树落进 Provider 后才渲染。)
 */
function TextChildren(props: { children?: JSX.Element }): JSX.Element {
  const resolved = resolveChildren(() => props.children);
  const kids = createMemo(() => {
    const value = resolved();
    const list = Array.isArray(value) ? value : value == null ? [] : [value];
    return list.map((child) => {
      if (typeof child === 'string') return renderString(child);
      if (typeof child === 'number') return String(child);
      return child;
    });
  });
  return kids as unknown as JSX.Element;
}

export function Text(props: TextProps): JSX.Element {
  // context 值在同一挂载点上是静态的(Provider 的 value 从不动态翻转),
  // setup 期读一次即可。
  const nested = useContext(NestedText);
  const click = clickHandlers(useRenderer(), () => props.onClick);
  const styled = createMemo(() => ({
    ...(props.color !== undefined ? { fg: props.color } : {}),
    ...(props.backgroundColor !== undefined ? { bg: props.backgroundColor } : {}),
    attributes: attributesOf(props),
  }));
  if (nested) {
    // 样式必须经 style prop(理由见 spanStyle 的注释)。
    return (
      <span
        style={{
          ...(props.color !== undefined ? { fg: props.color } : {}),
          ...(props.backgroundColor !== undefined ? { bg: props.backgroundColor } : {}),
          bold: props.bold === true,
          dim: props.dimColor === true,
          italic: props.italic === true,
          underline: props.underline === true,
          inverse: props.inverse === true,
          strikethrough: props.strikethrough === true,
        }}
      >
        <TextChildren>{props.children}</TextChildren>
      </span>
    );
  }
  return (
    <text
      {...styled()}
      wrapMode={props.wrap === 'truncate-end' ? 'none' : 'word'}
      truncate={props.wrap === 'truncate-end'}
      // 不可点时显式给 undefined:上游 setter 收到 undefined 会删掉监听,
      // 与「从未挂过」等价,不留额外开销。
      onMouseDown={props.onClick ? click.handleDown : undefined}
      onMouseUp={props.onClick ? click.handleUp : undefined}
    >
      <NestedText.Provider value={true}>
        <TextChildren>{props.children}</TextChildren>
      </NestedText.Provider>
    </text>
  );
}

// ---------------------------------------------------------------------------
// ScrollArea
// ---------------------------------------------------------------------------

/**
 * 时间线滚动容器:粘底跟随流式输出,用户上滚自动解粘、回到底部重新粘住
 * (OpenTUI stickyScroll 语义);滚轮/PageUp/PageDown 可用。
 *
 * flex 四件套是实测的必要参数(T0 探针②):Yoga 的 flexShrink 裸默认是 0,
 * 内容超高时 scrollbox 会把兄弟节点(底部输入区)挤出屏幕外并与之重叠;
 * grow 1 + shrink 1 + basis 0 + minHeight 0 才是「占满剩余空间」的正确写法。
 */
export function ScrollArea(props: { children?: JSX.Element }): JSX.Element {
  return (
    <scrollbox
      stickyScroll={true}
      stickyStart="bottom"
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      minHeight={0}
    >
      <NestedText.Provider value={false}>{props.children}</NestedText.Provider>
    </scrollbox>
  );
}

// ---------------------------------------------------------------------------
// Box
// ---------------------------------------------------------------------------

export interface BoxProps {
  flexDirection?: 'row' | 'column';
  flexGrow?: number;
  flexShrink?: number;
  flexBasis?: number | 'auto';
  justifyContent?: 'flex-start' | 'flex-end' | 'center' | 'space-between';
  alignItems?: 'flex-start' | 'flex-end' | 'center';
  width?: number | 'auto' | `${number}%`;
  height?: number | 'auto' | `${number}%`;
  minHeight?: number;
  maxHeight?: number;
  marginTop?: number;
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
  paddingX?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  gap?: number;
  /** Ink 只有名字差异:'round' → OpenTUI 'rounded'。 */
  borderStyle?: 'round';
  borderColor?: string;
  /** 左键单击(判定见 clickHandlers)。命中区就是这个 Box 的布局矩形。 */
  onClick?: (info: ClickInfo) => void;
  /**
   * 滚轮。命中区同上——事件在子节点上产生、冒泡到这里,所以挂在容器 Box 上
   * 就覆盖整块区域,不必逐行去挂。
   */
  onScroll?: (direction: ScrollDirection) => void;
  children?: JSX.Element;
}

export function Box(props: BoxProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    'flexDirection',
    'flexShrink',
    'borderStyle',
    'borderColor',
    'paddingX',
    'onClick',
    'onScroll',
    'children',
  ]);
  const click = clickHandlers(useRenderer(), () => local.onClick);
  const scroll = scrollHandler(() => local.onScroll);
  // 条件键收进 memo 再 spread:直接写 `borderColor={undefined}` 会以
  // undefined 覆盖 renderable 的默认值,语义与「不传」不同。
  const extras = createMemo(() => ({
    ...(local.borderStyle !== undefined ? { border: true, borderStyle: 'rounded' as const } : {}),
    ...(local.borderColor !== undefined ? { borderColor: local.borderColor } : {}),
    ...(local.paddingX !== undefined
      ? { paddingLeft: local.paddingX, paddingRight: local.paddingX }
      : {}),
  }));
  return (
    <box
      flexDirection={local.flexDirection ?? 'row'} // Ink 默认 row(Yoga 裸默认是 column)
      flexShrink={local.flexShrink ?? 1} // Ink 默认 1(Yoga 裸默认 0)
      {...extras()}
      {...rest}
      onMouseDown={local.onClick ? click.handleDown : undefined}
      onMouseUp={local.onClick ? click.handleUp : undefined}
      onMouseScroll={local.onScroll ? scroll : undefined}
    >
      {/* Box 边界重置嵌套判定:Box 内的 <Text> 是新的顶层文本块 */}
      <NestedText.Provider value={false}>{local.children}</NestedText.Provider>
    </box>
  );
}
