import { createEffect, createMemo, createSignal, For, onCleanup, untrack } from 'solid-js';
import { Box, KeyboardScope, Text, useInput, useTerminalSize, type JSX } from './kit.js';
import type {
  ComponentHost,
  EditorComponentFactory,
  ExtensionComponent,
  ExtensionEditorComponent,
  ExtensionSurface,
  UiCustomRequest,
} from '../core/extension-types.js';
import { extensionTheme, keyToData } from './extension-theme.js';
import { theme } from './theme.js';
import { overlayOptionsOf, resolveOverlayLayout } from './overlay-layout.js';

/**
 * 扩展渲染层在 TUI 里的落点(Pi 的 Component 同形):
 *  - `SurfaceView` 画一块 widget / header / footer——一组行,或一个按需重画
 *    的组件(工厂只跑一次,`host.requestRender()` 让它重画);
 *  - `CustomHost` 画 `ui.custom` 挂出来的组件,并把键盘整个交给它;
 *  - `EditorHost` 画 `ui.setEditorComponent` 顶替输入框的编辑器,同样独占键盘。
 * 行里的 ANSI 由 kit 的 Text 解析;每行 truncate,不让扩展把整块顶成多行。
 */

interface Instance<T extends ExtensionComponent = ExtensionComponent> {
  component: T;
  tick: () => number;
  requestRender: () => void;
}

/**
 * 组件实例化一次,重画靠 tick 信号;宽度从 host 现读。**三个宿主共用这一份**
 * (widget/header/footer 的 SurfaceView、`ui.custom` 的 CustomHost、
 * `setEditorComponent` 的 EditorHost)——`ComponentHost` 只允许有一个构造点,
 * 否则给它加一个成员、或改"按键之后要不要自动重画"这条约定,要在三处各改一笔。
 * 工厂要多收一个参数(done / submit)时在调用方闭包里给,见 CustomHost。
 */
function instantiate<T extends ExtensionComponent>(
  factory: (host: ComponentHost) => T,
  width: () => number,
): Instance<T> {
  const [tick, setTick] = createSignal(0);
  const requestRender = (): void => {
    setTick((n) => n + 1);
  };
  const host: ComponentHost = {
    requestRender,
    get width() {
      return width();
    },
    theme: extensionTheme,
  };
  return { component: untrack(() => factory(host)), tick, requestRender };
}

/**
 * 独占键盘的扩展组件共用的收键:esc 先问宿主(`escape()` 返回 true 表示宿主
 * 已消费——运行中的中断),其余按键还原成 Pi 风格的原始序列交给组件,按完
 * 重画一次(Pi 的组件多半靠宿主在每次按键后重画,不必每个 handleInput 都
 * 手动要求)。CustomHost 与 EditorHost 共用:「esc 归谁」只写在这一处。
 */
function useComponentKeys(instance: Instance, escape: () => boolean): void {
  useInput((input, key) => {
    if (key.escape && escape()) return;
    instance.component.handleInput?.(keyToData(input, key), key);
    instance.requestRender();
  });
}

/**
 * 扩展给出的一组行(可带 ANSI)。**唯一的一处**:widget / header / footer、
 * `ui.custom` 的组件、工具的 renderCall / renderResult、自定义消息都画成
 * 这个样子——"扩展写的行怎么截断"只允许有一个答案。
 */
export function Lines(props: { lines: string[] }): JSX.Element {
  return (
    <Box flexDirection="column">
      <For each={props.lines}>{(line) => <Text wrap="truncate-end">{line}</Text>}</For>
    </Box>
  );
}

export function SurfaceView(props: { surface: ExtensionSurface }): JSX.Element {
  const size = useTerminalSize();
  // 工厂按 surface 身份实例化一次;换了 surface 才重建。
  const instance = createMemo((): Instance | undefined => {
    const surface = props.surface;
    return typeof surface === 'function' ? instantiate(surface, () => size.columns) : undefined;
  });
  const lines = createMemo((): string[] => {
    const inst = instance();
    if (!inst) return props.surface as string[];
    inst.tick();
    return inst.component.render(size.columns);
  });
  return <Lines lines={lines()} />;
}

/**
 * `ui.custom` 的宿主:与回退选择器同一条互斥分支,渲染期间 Input 已卸载,
 * useInput 独占键盘。done 只生效一次(组件可能在 esc 与回车里各调一遍)。
 */
export function CustomHost(props: {
  request: UiCustomRequest;
  onDone: (value: unknown) => void;
  /** 组件可画的宽度;缺省整个终端(覆盖层给的是框内宽度)。 */
  width?: () => number;
  /** 返回 true 表示这次 esc 已被宿主消费(运行中的中断),不再转发给组件。见 EditorHost。 */
  onEscape?: () => boolean;
  /** 渲染出的行数变了就报一声(覆盖层据此按内容高度定位)。 */
  onLines?: (count: number) => void;
}): JSX.Element {
  const size = useTerminalSize();
  const width = (): number => props.width?.() ?? size.columns;
  let finished = false;
  const done = (value: unknown): void => {
    if (finished) return;
    finished = true;
    props.onDone(value);
  };
  const instance = instantiate((host) => props.request.factory(host, done), width);
  const lines = createMemo((): string[] => {
    instance.tick();
    return instance.component.render(width());
  });
  createEffect(() => props.onLines?.(lines().length));
  useComponentKeys(instance, () => props.onEscape?.() ?? false);
  onCleanup(() => {
    // 覆盖层被顶掉(会话关闭等)时组件没 done:按「没答」收尾,扩展不会挂住。
    done(undefined);
  });
  return <Lines lines={lines()} />;
}

/**
 * `ui.custom(…, { overlay: true })` 的宿主:浮在时间线之上的一个圆角框,输入框
 * 留在原地(但键盘归组件,与 CustomHost 一样独占)。位置与尺寸由
 * overlay-layout.ts 按终端尺寸现算,终端一变就重排;`hidden`(把手的
 * setHidden,或 `visible(w, h)` 说了不画)时整块不画也不占布局,组件仍活着。
 * 框宽 = 内容宽 + 边框 2 + 内边距 2。
 */
export function OverlayHost(props: {
  request: UiCustomRequest;
  onDone: (value: unknown) => void;
  /**
   * 此刻画不画(App 的 overlayActive,即 `overlayShown`)。由 App 传进来而不是
   * 这里再算一遍:画框与收键必须是**同一个**判据,它也管着底部区的键盘作用域。
   */
  shown: () => boolean;
  /** 跑着的时候 esc 归中断(同 EditorHost):一个不处理 esc 的覆盖层不该让用户只剩双 ctrl+c。 */
  onEscape?: () => boolean;
}): JSX.Element {
  const size = useTerminalSize();
  // 内容行数:没给 height 的覆盖层按它定位(居中、贴底才对得上);框高 = 行数 + 上下边框。
  const [rows, setRows] = createSignal<number | undefined>(undefined);
  const layout = createMemo(() => {
    const content = rows();
    return resolveOverlayLayout(
      overlayOptionsOf(props.request),
      size.columns,
      size.rows,
      content === undefined ? undefined : content + 2,
    );
  });
  const CHROME = 4;
  return (
    <Box
      position="absolute"
      zIndex={100}
      visible={props.shown()}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      {...layout()}
    >
      {/* 藏起来的覆盖层把键盘还回去:组件还活着,只是不画、不收键。 */}
      <KeyboardScope active={props.shown}>
        <CustomHost
          request={props.request}
          onDone={props.onDone}
          width={() => Math.max(1, layout().width - CHROME)}
          onLines={setRows}
          onEscape={props.onEscape}
        />
      </KeyboardScope>
    </Box>
  );
}

/**
 * 扩展编辑器的读写口,App 把它接到 `attachUi` 的 getEditorText / setEditorText /
 * pasteToEditor 上——缺省输入框与扩展编辑器共用同一个 ref 对象,谁挂着谁填。
 */
export interface EditorRef {
  read?: () => string;
  write?: (text: string) => void;
  insert?: (text: string) => void;
}

/**
 * `ui.setEditorComponent` 的宿主:顶替缺省输入框,键盘整个交给组件;组件调
 * `submit(text)` 与在缺省输入框回车同一条路(App 的 handleSubmit)。组件的
 * 可选 `getText / setText / insertText` 填进 editorRef,扩展的 getEditorText
 * 之类照常可用;卸载时清掉,别让一个已经不在屏幕上的组件继续答草稿。
 *
 * **esc 有一个例外**,`onEscape` 就是为它而设:一轮正跑着的时候 esc 永远是
 * "中断",不转发给组件。全交给组件的话,一个不处理 esc 的编辑器扩展会让
 * 用户只剩双 ctrl+c 这一条路——而那是退出整个程序,不是停下这一轮。空闲时
 * esc 照常归组件(esc-esc 回退选择器因此在扩展编辑器挂着时不可用,那是
 * "键盘归组件"这条契约的应有之义)。
 */
export function EditorHost(props: {
  factory: EditorComponentFactory;
  onSubmit: (text: string) => void;
  /** 返回 true 表示这次 esc 已被宿主消费(运行中的中断),不再转发给组件。 */
  onEscape?: () => boolean;
  editorRef?: EditorRef;
}): JSX.Element {
  const size = useTerminalSize();
  const instance = instantiate<ExtensionEditorComponent>(
    (host) => props.factory(host, (text) => props.onSubmit(text)),
    () => size.columns,
  );
  const { component } = instance;
  const ref = props.editorRef;
  if (ref) {
    ref.read = () => component.getText?.() ?? '';
    ref.write = (text) => {
      component.setText?.(text);
      instance.requestRender();
    };
    ref.insert = (text) => {
      // 组件接了 insertText 才有"在光标处"可言(光标在组件自己肚子里);
      // 没接就退化成追加,总好过什么都不发生。
      if (component.insertText) component.insertText(text);
      else component.setText?.((component.getText?.() ?? '') + text);
      instance.requestRender();
    };
  }
  const lines = createMemo((): string[] => {
    instance.tick();
    return component.render(size.columns);
  });
  useComponentKeys(instance, () => props.onEscape?.() ?? false);
  onCleanup(() => {
    if (!ref) return;
    delete ref.read;
    delete ref.write;
    delete ref.insert;
  });
  return <Lines lines={lines()} />;
}
