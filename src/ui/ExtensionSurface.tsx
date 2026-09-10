import { createMemo, createSignal, For, onCleanup, untrack } from 'solid-js';
import { Box, Text, useInput, useTerminalSize, type JSX } from './kit.js';
import type {
  ComponentHost,
  ExtensionComponent,
  ExtensionSurface,
  UiCustomRequest,
} from '../core/extension-types.js';
import { extensionTheme, keyToData } from './extension-theme.js';

/**
 * 扩展渲染层在 TUI 里的落点(Pi 的 Component 同形):
 *  - `SurfaceView` 画一块 widget / header / footer——一组行,或一个按需重画
 *    的组件(工厂只跑一次,`host.requestRender()` 让它重画);
 *  - `CustomHost` 画 `ui.custom` 挂出来的组件,并把键盘整个交给它。
 * 行里的 ANSI 由 kit 的 Text 解析;每行 truncate,不让扩展把整块顶成多行。
 */

interface Instance {
  component: ExtensionComponent;
  tick: () => number;
  requestRender: () => void;
}

/** 组件实例化一次,重画靠 tick 信号;宽度从 host 现读。 */
function instantiate(
  factory: (host: ComponentHost) => ExtensionComponent,
  width: () => number,
): Instance {
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
}): JSX.Element {
  const size = useTerminalSize();
  let finished = false;
  const done = (value: unknown): void => {
    if (finished) return;
    finished = true;
    props.onDone(value);
  };
  const instance = instantiate((host) => props.request.factory(host, done), () => size.columns);
  const lines = createMemo((): string[] => {
    instance.tick();
    return instance.component.render(size.columns);
  });
  useInput((input, key) => {
    instance.component.handleInput?.(keyToData(input, key), key);
    // 组件自己不 requestRender 的话按键之后也重画一次:Pi 的组件多半靠宿主
    // 在每次按键后重画,不必每个 handleInput 都手动要求。
    instance.requestRender();
  });
  onCleanup(() => {
    // 覆盖层被顶掉(会话关闭等)时组件没 done:按「没答」收尾,扩展不会挂住。
    done(undefined);
  });
  return <Lines lines={lines()} />;
}
