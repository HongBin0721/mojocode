/** @jsxImportSource @opentui/react */
/**
 * 渲染器适配层:以 Ink 的 API 形状(Box/Text/useInput/useApp/render)包装
 * OpenTUI 的 @opentui/react。
 *
 * 存在的理由有二:
 * 1. 迁移面收敛——全部 UI 组件只改 import('ink' → './kit.js'),JSX 与
 *    键盘逻辑原样保留;
 * 2. 上游隔离——OpenTUI 还在 0.x,破坏性变更只需改这一个文件。
 *
 * 与 Ink 的三处语义差异,均已在此抹平:
 * - OpenTUI 的 <text> 不解析 ANSI(T0 探针①):Text 检测到子串含 ESC 时
 *   经 parseAnsiSpans 转成 <span> 段;SGR 39/49 恢复为「继承外层」,与
 *   chalk 的嵌套行为一致(Diff 背景高亮依赖)。
 * - 嵌套 <Text> 在 OpenTUI 里必须是 <span>(上游 #438):以 context 判定
 *   自身层级自动切换。
 * - Yoga 裸默认与 Ink 不同:Ink 的 Box 默认 flexDirection="row"、
 *   flexShrink=1,此处补齐同样的默认值,否则既有布局全部错位。
 */
import { createCliRenderer, TextAttributes, type CliRenderer, type KeyEvent } from '@opentui/core';
import {
  createRoot,
  flushSync,
  useKeyboard,
  usePaste,
  useRenderer,
  useTerminalDimensions,
} from '@opentui/react';
import { decodePasteBytes } from '@opentui/core';
import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { hasAnsi, parseAnsiSpans, type AnsiSpan } from './ansi-spans.js';

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
  isActive?: boolean;
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
 * 另一处刻意抹平的差异:Ink 把一个 stdin chunk 作为**一整个字符串**交给
 * 回调,而 OpenTUI 把它拆成逐字符 keypress **同步连发**。组件的编辑逻辑
 * (如 Input 的 insert)读的是本次渲染闭包里的 state,同一批到达的字符
 * 若逐个派发,前面的全部会被后面的旧闭包覆盖——快速输入/按键重复下丢字。
 * 因此普通字符在同一个微任务内累积,批尾一次性派发;特殊键到达时先冲刷
 * 累积再派发,顺序不乱。
 *
 * 冲刷必须包在 flushSync 里:同一批的「文字 + 回车」(快速输入、按键重复、
 * 无 bracketed paste 的终端里粘贴含换行的文本)会先派发文字、紧接着派发
 * 回车,而回车的处理器若仍是冲刷前那次渲染的闭包,读到的 value 还是空的
 * ——文字进了输入框却提交了空串,回车像被吞掉一样。flushSync 强制在两次
 * 派发之间完成一次提交,`ref.current.handler` 随之更新为新闭包。
 */
export function useInput(
  handler: (input: string, key: Key) => void,
  options: UseInputOptions = {},
): void {
  const active = options.isActive !== false;
  const ref = useRef({ handler, active });
  ref.current = { handler, active };
  const pending = useRef('');
  const flushQueued = useRef(false);

  /** @param sync 特殊键紧随其后时必须同步提交,见文件头注释。 */
  const flush = (sync = false): void => {
    flushQueued.current = false;
    if (pending.current === '') return;
    const merged = pending.current;
    pending.current = '';
    const dispatch = () => ref.current.handler(merged, emptyKey());
    if (sync) flushSync(dispatch);
    else dispatch();
  };

  useKeyboard((event) => {
    if (!ref.current.active) return;
    const mapped = mapKeyEvent(event);
    if (!mapped) return;
    if (isPlainInput(mapped.input, mapped.key)) {
      pending.current += mapped.input;
      if (!flushQueued.current) {
        flushQueued.current = true;
        queueMicrotask(flush);
      }
      return;
    }
    flush(true); // 特殊键先冲刷已累积的普通字符,保持派发顺序
    ref.current.handler(mapped.input, mapped.key);
  });

  usePaste((event) => {
    if (!ref.current.active) return;
    const text = decodePasteBytes(event.bytes);
    if (text.length === 0) return;
    flush(true);
    ref.current.handler(text, emptyKey());
  });
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

export function useApp(): { exit: () => void } {
  const renderer = useRenderer();
  return useMemo(() => ({ exit: () => void renderer.destroy() }), [renderer]);
}

/** 终端尺寸(替代 Ink 的 useStdout().columns/rows 与 process.stdout 直读)。 */
export function useTerminalSize(): { columns: number; rows: number } {
  const { width, height } = useTerminalDimensions();
  return { columns: width, rows: height };
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
 */
export async function render(
  node: React.ReactNode,
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
  const root = createRoot(renderer);
  root.render(node);
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
  children?: React.ReactNode;
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

function spanAttributes(span: AnsiSpan): number {
  let attrs = 0;
  if (span.bold) attrs |= TextAttributes.BOLD;
  if (span.dim) attrs |= TextAttributes.DIM;
  if (span.italic) attrs |= TextAttributes.ITALIC;
  if (span.underline) attrs |= TextAttributes.UNDERLINE;
  if (span.inverse) attrs |= TextAttributes.INVERSE;
  if (span.strikethrough) attrs |= TextAttributes.STRIKETHROUGH;
  return attrs;
}

/** 字符串子节点:含 ANSI 时拆成 <span> 段,否则原样。 */
function renderString(text: string, keyPrefix: string): React.ReactNode {
  if (!hasAnsi(text)) return text;
  return parseAnsiSpans(text).map((span, i) => (
    <span
      key={`${keyPrefix}-${i}`}
      {...(span.fg !== undefined ? { fg: span.fg } : {})}
      {...(span.bg !== undefined ? { bg: span.bg } : {})}
      attributes={spanAttributes(span)}
    >
      {span.text}
    </span>
  ));
}

function renderChildren(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child, i) => {
    if (typeof child === 'string') return renderString(child, `s${i}`);
    if (typeof child === 'number') return String(child);
    return child;
  });
}

export function Text(props: TextProps): React.ReactNode {
  const nested = useContext(NestedText);
  const attributes = attributesOf(props);
  const styled = {
    ...(props.color !== undefined ? { fg: props.color } : {}),
    ...(props.backgroundColor !== undefined ? { bg: props.backgroundColor } : {}),
    attributes,
  };
  const kids = renderChildren(props.children);
  if (nested) {
    return <span {...styled}>{kids}</span>;
  }
  const truncate = props.wrap === 'truncate-end';
  return (
    <text {...styled} wrapMode={truncate ? 'none' : 'word'} truncate={truncate}>
      <NestedText.Provider value={true}>{kids}</NestedText.Provider>
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
export function ScrollArea({ children }: { children?: React.ReactNode }): React.ReactNode {
  return (
    <scrollbox
      stickyScroll={true}
      stickyStart="bottom"
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      minHeight={0}
    >
      <NestedText.Provider value={false}>{children}</NestedText.Provider>
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
  children?: React.ReactNode;
}

export function Box(props: BoxProps): React.ReactNode {
  const {
    flexDirection = 'row', // Ink 默认 row(Yoga 裸默认是 column)
    flexShrink = 1, // Ink 默认 1(Yoga 裸默认 0)
    borderStyle,
    borderColor,
    paddingX,
    children,
    ...rest
  } = props;
  return (
    <box
      flexDirection={flexDirection}
      flexShrink={flexShrink}
      {...(borderStyle !== undefined
        ? { border: true, borderStyle: 'rounded' as const }
        : {})}
      {...(borderColor !== undefined ? { borderColor } : {})}
      {...(paddingX !== undefined ? { paddingLeft: paddingX, paddingRight: paddingX } : {})}
      {...rest}
    >
      {/* Box 边界重置嵌套判定:Box 内的 <Text> 是新的顶层文本块 */}
      <NestedText.Provider value={false}>{children}</NestedText.Provider>
    </box>
  );
}
