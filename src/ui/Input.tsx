import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from './kit.js';
import { theme, glyphs, inputModeStyle } from './theme.js';
import { t } from '../i18n/index.js';
import { fuzzyFilter } from '../app/file-index.js';
import type { ImageAttachment } from '../app/attachments.js';
import type { ClipboardImage } from '../app/clipboard.js';

export interface CommandOption {
  /** 提交给命令的参数值。 */
  value: string;
  /** 选项旁展示的说明(服务商名称、模式含义等)。 */
  label?: string;
  /** 当前生效的值——打开选择器时预选,并带 ✓ 标记。 */
  current?: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  /**
   * 别名。菜单里以 `/name (alias)` 展示,输入别名同样能匹配到本命令;
   * 补全与提交仍用主名,别名的分发由 App 的 runCommand 自行处理。
   */
  aliases?: string[];
  /**
   * 枚举参数的取值来源。提供了它的命令,在菜单上回车会进入二级选择器
   * 而不是直接执行;异步形式用于要请求线上数据的命令(如 /model)。
   */
  options?: () => CommandOption[] | Promise<CommandOption[]>;
  /**
   * 多选模式:空格切换选中,回车把所有选中值(按选项顺序)作为参数提交;
   * 全部取消时提交 `none`。`current` 标记初始选中集合。
   */
  multi?: boolean;
}

/** 命令的展示名:主名加括号列出别名,如 `/exit (quit)`。菜单与 /help 共用。 */
export function formatCommandLabel(c: SlashCommand): string {
  return `/${c.name}${c.aliases?.length ? ` (${c.aliases.join(', ')})` : ''}`;
}

interface Props {
  /** 第二个参数是随消息发送的图片(ctrl+v 粘贴的占位符所对应的数据)。 */
  onSubmit: (value: string, images?: ImageAttachment[]) => void;
  disabled: boolean;
  placeholder: string;
  /**
   * 当前权限模式标签(plan / full-access / read-only / ask…)。边框与提示符
   * 的颜色、字形据此变化,见 theme.inputModeStyle;不传则用默认样式。
   */
  mode?: string;
  /**
   * 任务运行中。输入仍然可用(引导消息),但边框退为弱化色,让视觉焦点
   * 留给上方的流式输出;提示符保持模式色,示意"这里还能打字"。
   */
  busy?: boolean;
  /** 自动补全菜单中展示的斜杠命令。 */
  commands: SlashCommand[];
  /**
   * 选择器和命令菜单都没打开时按下 esc 的回调(App 用它中断运行中的任
   * 务)。esc 的分发必须收在这一个组件里:两个并存的 useInput 会同时收到
   * 按键,否则"esc 收起菜单"会顺带触发外层的中断。
   */
  onEscape?: () => void;
  /**
   * 外部预填输入框(esc-esc 回退后把原消息放回来编辑)。每次预填传入新的
   * 对象,写入后必须由 `onPrefillConsumed` 清掉。
   */
  prefill?: { text: string };
  /**
   * 预填已写入输入框,调用方应把 prefill 置空。
   *
   * 去重不能只靠组件内的 ref:权限确认框出现时 Input 会整个卸载,重新挂载
   * 后 ref 归零,一条早就用过的 prefill 会二次覆盖用户当前的草稿。
   */
  onPrefillConsumed?: () => void;
  /**
   * @ 文件引用补全的数据源(相对 posix 路径列表)。通过 prop 注入而不是
   * 组件自己扫盘:保持 Input 不碰文件系统,测试时注入假列表即可。
   * 不传则完全关闭 @ 补全。
   */
  fileIndex?: () => Promise<string[]>;
  /**
   * ctrl+v 时读取剪贴板图片。与 fileIndex 同理由注入:组件不碰子进程,
   * 测试注假的。不传则 ctrl+v 保持原样(被控制序列吞噬)。
   */
  readClipboardImage?: () => Promise<ClipboardImage | undefined>;
  /** 粘贴失败/为空/超限时的提示(已本地化),由调用方决定呈现方式。 */
  onImageNotice?: (message: string) => void;
}

interface SelectorState {
  command: SlashCommand;
  options: CommandOption[];
  cursor: number;
  loading: boolean;
  /** 多选模式下当前选中的值集合。 */
  selected: Set<string>;
}

/** 粘贴图片的上限:单张字节数、待发送总字节数与张数(与 @ 引用图片一致)。 */
const MAX_PASTE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_PASTE_BYTES = 10 * 1024 * 1024;
const MAX_PENDING_IMAGES = 8;
/** 粘贴占位符。提交时据此把文本里的占位符与图片数据配对。 */
const IMAGE_PLACEHOLDER = /\[image #(\d+)\]/g;

/** 二级选择器一屏最多显示的选项数,超出部分滚动。 */
const SELECTOR_WINDOW = 8;
/** 命令菜单一屏最多显示的候选数,超出部分滚动(与二级选择器一致)。 */
const MENU_WINDOW = 8;

/**
 * 带历史记录、多行编辑和斜杠命令菜单的输入框。
 *
 * 手写而不套现成的文本输入组件,是因为多行输入、历史回溯、命令菜单和
 * 二级选择器需要共用同一个按键处理器——把这些叠加在受控的第三方
 * 输入组件上反而更乱。
 *
 * 换行方式:shift+enter(kitty 键盘协议,iTerm2 3.5+/kitty/WezTerm/
 * Ghostty 等终端可用)、option+enter、ctrl+j,以及行尾 `\` + 回车
 * (任何终端都可用的兜底)。传统终端把 shift+enter 和 enter 发成同一个
 * 字节,无法区分,所以需要这些替代按键。
 */
export function Input({
  onSubmit,
  disabled,
  placeholder,
  mode,
  busy,
  commands,
  onEscape,
  prefill,
  onPrefillConsumed,
  fileIndex,
  readClipboardImage,
  onImageNotice,
}: Props): React.ReactElement {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [selector, setSelector] = useState<SelectorState | undefined>(undefined);
  // 递增代号,防止上一次异步加载的选项覆盖已关闭/重开的选择器。
  const selectorGen = useRef(0);
  // @ 文件菜单的状态与斜杠菜单分开:两者触发与重置语义各自独立。
  const [fileMenuIndex, setFileMenuIndex] = useState(0);
  const [fileMenuDismissed, setFileMenuDismissed] = useState(false);
  /** 用户是否用上下键在文件菜单里选过——回车是否该拦截取决于它。 */
  const [fileMenuTouched, setFileMenuTouched] = useState(false);
  const [fileList, setFileList] = useState<string[] | undefined>(undefined);
  // 同 selectorGen:丢弃过期的异步文件扫描结果。
  const fileGen = useRef(0);
  // ctrl+v 粘贴的图片,按占位符编号索引;提交/清空输入时一并清理。
  const [pastedImages, setPastedImages] = useState<Map<number, ImageAttachment>>(new Map());
  // 单调递增,挂载期内不回收:历史回翻出来的旧占位符不能与新粘贴撞号。
  const imageId = useRef(0);
  const pasteInFlight = useRef(false);
  // useInput 是同步的而剪贴板读取是异步的:插入占位符时必须用 ref 里的
  // 最新值,否则读取的几十毫秒里用户打的字会被闭包旧值覆盖。
  const valueRef = useRef(value);
  valueRef.current = value;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  // 外部预填:写入后立刻通知调用方清空,消费权只有一次。
  useEffect(() => {
    if (!prefill) return;
    setValue(prefill.text);
    setCursor(prefill.text.length);
    setHistoryIndex(undefined);
    onPrefillConsumed?.();
  }, [prefill, onPrefillConsumed]);

  // 输入变化时重置菜单选中项,并让被 esc 收起的菜单重新出现。
  useEffect(() => {
    setMenuIndex(0);
    setMenuDismissed(false);
    setFileMenuIndex(0);
    setFileMenuDismissed(false);
    setFileMenuTouched(false);
  }, [value]);

  // 占位符从文本里消失(整删、ctrl+u/w、清空)时同步丢弃暂存的图片,
  // 让"已附加 N 张"提示与实际会发送的内容保持一致。
  useEffect(() => {
    if (pastedImages.size === 0) return;
    const present = new Set<number>();
    for (const match of value.matchAll(IMAGE_PLACEHOLDER)) present.add(Number(match[1]));
    if ([...pastedImages.keys()].some((id) => !present.has(id))) {
      setPastedImages((prev) => new Map([...prev].filter(([id]) => present.has(id))));
    }
  }, [value, pastedImages]);

  const showMenu =
    !selector &&
    !menuDismissed &&
    value.startsWith('/') &&
    !value.includes(' ') &&
    !value.includes('\n');
  const matches = showMenu
    ? commands.filter((c) =>
        [c.name, ...(c.aliases ?? [])].some((n) => n.startsWith(value.slice(1).toLowerCase())),
      )
    : [];
  const menuCursor = matches.length > 0 ? Math.min(menuIndex, matches.length - 1) : 0;
  // 光标居中的滚动窗口:候选多于一屏时跟随光标滚动,而不是截断列表。
  const menuWindowStart = Math.max(
    0,
    Math.min(menuCursor - Math.floor(MENU_WINDOW / 2), matches.length - MENU_WINDOW),
  );

  // ── @ 文件引用补全 ──
  // 与斜杠菜单天然互斥:斜杠菜单要求整条以 `/` 开头且无空格,而 @token
  // 要求 `@` 在行首或空白之后,两个条件不可能同时成立。
  const fileToken = fileIndex && !selector ? atTokenAt(value, cursor) : undefined;
  const showFileMenu = fileToken !== undefined && !fileMenuDismissed;
  const fileLoading = showFileMenu && fileList === undefined;
  const fileMatches =
    showFileMenu && fileList ? fuzzyFilter(fileToken.query, fileList) : [];
  const fileCursor = fileMatches.length > 0 ? Math.min(fileMenuIndex, fileMatches.length - 1) : 0;
  const fileWindowStart = Math.max(
    0,
    Math.min(fileCursor - Math.floor(MENU_WINDOW / 2), fileMatches.length - MENU_WINDOW),
  );
  /**
   * 回车是否作用于文件菜单。模糊匹配是子序列匹配,几乎对任何词都能命中
   * 点什么;若回车一律插入,`看下 @types/node 的用法` 这类正常行文一按
   * 回车就被改写成不相干的仓库路径,而不是把消息发出去。因此只在用户
   * 确有选择意图时才拦截回车:
   *   - 刚敲下 `@` 还没打字(菜单是纯选择器);
   *   - 上下键移动过光标;
   *   - 候选确实以已输入的串开头(路径或文件名前缀)。
   * tab 不受此限——它本来就是"补全"键。
   */
  const fileQuery = fileToken?.query ?? '';
  const fileEnterSelects =
    fileMatches.length > 0 &&
    (fileQuery === '' || fileMenuTouched || isPrefixMatch(fileQuery, fileMatches[fileCursor]!));

  // token 激活时才懒加载文件列表(TTL 缓存在 App 注入的列举器里)。
  const fileTokenActive = fileToken !== undefined;
  useEffect(() => {
    if (!fileTokenActive || !fileIndex) return;
    const gen = ++fileGen.current;
    void fileIndex().then(
      (files) => {
        if (fileGen.current === gen) setFileList(files);
      },
      () => {
        // 扫描失败静默降级为空列表:补全弹窗消失,输入本身不受影响。
        if (fileGen.current === gen) setFileList([]);
      },
    );
  }, [fileTokenActive, fileIndex]);

  /**
   * 菜单上回车/tab 作用的命令。精确匹配优先于光标位置:`model` 排在 `mode`
   * 之前,输完整的 `/mode` 时光标默认停在 `model` 上,直接取光标项会执行错
   * 命令。用户主动移动过光标(menuIndex 非 0)时以光标为准。
   */
  function menuTarget(): SlashCommand | undefined {
    if (matches.length === 0) return undefined;
    if (menuIndex === 0) {
      const typed = value.slice(1).toLowerCase();
      const exact = matches.find((c) => c.name === typed || c.aliases?.includes(typed));
      if (exact) return exact;
    }
    return matches[menuCursor];
  }

  /** 把文件菜单当前选中项拼进 @token 区间(token 起点到光标),光标移到其后。 */
  function insertFileSelection() {
    const path = fileMatches[fileCursor];
    if (!path || !fileToken) return;
    const inserted = `@${path} `;
    setValue(value.slice(0, fileToken.start) + inserted + value.slice(cursor));
    setCursor(fileToken.start + inserted.length);
  }

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    // 按占位符在文本中的出现顺序配对图片;被删掉的占位符自然收集不到,
    // 没有背书数据的占位符(历史回翻/手打)退化为字面文本。
    const images: ImageAttachment[] = [];
    const seen = new Set<number>();
    for (const match of trimmed.matchAll(IMAGE_PLACEHOLDER)) {
      const id = Number(match[1]);
      if (seen.has(id)) continue;
      seen.add(id);
      const image = pastedImages.get(id);
      if (image) images.push(image);
    }
    setHistory((prev) => [trimmed, ...prev.filter((h) => h !== trimmed)].slice(0, 100));
    setHistoryIndex(undefined);
    setValue('');
    setCursor(0);
    if (pastedImages.size > 0) setPastedImages(new Map());
    onSubmit(trimmed, images.length > 0 ? images : undefined);
  }

  /** ctrl+v:异步读剪贴板,成功则在光标处插入 `[image #N]` 并暂存图片。 */
  function pasteImage() {
    if (!readClipboardImage || pasteInFlight.current) return;
    if (pastedImages.size >= MAX_PENDING_IMAGES) {
      onImageNotice?.(t('notice.tooManyImages', { n: MAX_PENDING_IMAGES }));
      return;
    }
    pasteInFlight.current = true;
    readClipboardImage().then(
      (image) => {
        pasteInFlight.current = false;
        if (!image) {
          onImageNotice?.(t('notice.clipboardNoImage'));
          return;
        }
        // base64 比原始字节多约 1/3,按解码后的体积检查。
        const bytes = image.data.length * 0.75;
        if (bytes > MAX_PASTE_BYTES) {
          onImageNotice?.(t('notice.imageTooLarge'));
          return;
        }
        // 总量也要拦:8 张 5MB 的截图会让这一条消息在会话文件里占几十 MB,
        // 而且此后每一步都要重新上传(压缩只剥离摘要请求里的图片)。
        const pendingBytes = [...pastedImages.values()].reduce(
          (sum, img) => sum + img.data.length * 0.75,
          0,
        );
        if (pendingBytes + bytes > MAX_TOTAL_PASTE_BYTES) {
          onImageNotice?.(t('notice.imagesTooLarge'));
          return;
        }
        const id = ++imageId.current;
        const ext = image.mediaType === 'image/jpeg' ? 'jpg' : 'png';
        setPastedImages((prev) =>
          new Map(prev).set(id, {
            mediaType: image.mediaType,
            data: image.data,
            filename: `clipboard-${id}.${ext}`,
          }),
        );
        const at = cursorRef.current;
        const placeholder = `[image #${id}]`;
        setValue(valueRef.current.slice(0, at) + placeholder + valueRef.current.slice(at));
        setCursor(at + placeholder.length);
      },
      () => {
        pasteInFlight.current = false;
        onImageNotice?.(t('notice.clipboardReadFailed'));
      },
    );
  }

  function openSelector(command: SlashCommand) {
    const gen = ++selectorGen.current;
    setSelector({ command, options: [], cursor: 0, loading: true, selected: new Set() });
    void Promise.resolve(command.options!()).then(
      (options) => {
        if (selectorGen.current !== gen) return;
        if (options.length === 0) {
          setSelector(undefined);
          submit(`/${command.name}`);
          return;
        }
        const current = options.findIndex((o) => o.current);
        const selected = new Set(options.filter((o) => o.current).map((o) => o.value));
        setSelector({
          command,
          options,
          cursor: command.multi ? 0 : Math.max(0, current),
          loading: false,
          selected,
        });
      },
      () => {
        if (selectorGen.current !== gen) return;
        // 选项加载失败(如 /model 拉取线上列表出错)——回退为提交无参
        // 命令,让命令自身把错误报告到时间线上。
        setSelector(undefined);
        submit(`/${command.name}`);
      },
    );
  }

  useInput(
    (input, key) => {
      // ── 二级选择器打开时,按键只在选择器内生效 ──
      if (selector) {
        if (key.escape) {
          selectorGen.current++;
          setSelector(undefined);
          return;
        }
        if (selector.loading || selector.options.length === 0) return;
        if (key.upArrow) {
          setSelector((s) =>
            s && { ...s, cursor: (s.cursor + s.options.length - 1) % s.options.length },
          );
          return;
        }
        if (key.downArrow) {
          setSelector((s) => s && { ...s, cursor: (s.cursor + 1) % s.options.length });
          return;
        }
        // 多选:空格切换光标处选项的选中状态。
        if (selector.command.multi && input === ' ' && !key.return) {
          setSelector((s) => {
            if (!s) return s;
            const option = s.options[s.cursor];
            if (!option) return s;
            const selected = new Set(s.selected);
            if (selected.has(option.value)) selected.delete(option.value);
            else selected.add(option.value);
            return { ...s, selected };
          });
          return;
        }
        if (key.return) {
          if (selector.command.multi) {
            // 按选项顺序提交选中值,保证参数顺序稳定;空选提交 none。
            const values = selector.options
              .filter((o) => selector.selected.has(o.value))
              .map((o) => o.value);
            selectorGen.current++;
            setSelector(undefined);
            submit(`/${selector.command.name} ${values.length > 0 ? values.join(' ') : 'none'}`);
            return;
          }
          const option = selector.options[selector.cursor];
          if (option) {
            selectorGen.current++;
            setSelector(undefined);
            submit(`/${selector.command.name} ${option.value}`);
          }
          return;
        }
        return;
      }

      // ── 换行:shift+enter / option+enter / ctrl+enter ──
      if (key.return && (key.shift || key.meta || key.ctrl)) {
        insert('\n');
        return;
      }
      // ctrl+j 同样插入换行(kitty 协议终端可用)。
      if (key.ctrl && input === 'j') {
        insert('\n');
        return;
      }

      if (key.return) {
        // 文件菜单打开且用户确有选择意图时,回车插入路径而不是提交。
        if (fileEnterSelects) {
          insertFileSelection();
          return;
        }
        // 命令菜单打开时,回车作用于菜单里选中的命令。
        if (matches.length > 0) {
          const command = menuTarget()!;
          if (command.options) {
            openSelector(command);
          } else {
            submit(`/${command.name}`);
          }
          return;
        }
        // 行尾 `\` + 回车 → 换行:对不支持 shift+enter 的终端的兜底。
        if (value[cursor - 1] === '\\') {
          setValue(value.slice(0, cursor - 1) + '\n' + value.slice(cursor));
          return;
        }
        submit(value);
        return;
      }

      // 必须排除 shift:shift+tab 是切换权限模式的全局快捷键(App.tsx),
      // kit 把它报成 tab + shift,不排除的话命令菜单一开就被补全吞掉。
      if (key.tab && !key.shift && fileMatches.length > 0) {
        insertFileSelection();
        return;
      }
      if (key.tab && !key.shift && matches.length > 0) {
        const completed = `/${menuTarget()!.name} `;
        setValue(completed);
        setCursor(completed.length);
        return;
      }

      if (key.escape) {
        // 文件菜单可见(含加载中)→ 只收起菜单,绝不落到 onEscape 触发中断。
        if (fileMatches.length > 0 || fileLoading) {
          setFileMenuDismissed(true);
        } else if (matches.length > 0) {
          setMenuDismissed(true);
        } else {
          onEscape?.();
        }
        return;
      }

      if (key.backspace || key.delete) {
        if (cursor > 0) {
          // 光标在图片占位符内部或紧随其后 → 整个占位符一次删除,
          // 不用一个字符一个字符地退格。
          const span = placeholderSpanAt(value, cursor);
          if (span) {
            setValue(value.slice(0, span.start) + value.slice(span.end));
            setCursor(span.start);
            return;
          }
          setValue(value.slice(0, cursor - 1) + value.slice(cursor));
          setCursor(cursor - 1);
        }
        return;
      }

      if (key.leftArrow) {
        setCursor(Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(value.length, cursor + 1));
        return;
      }

      // 行内定位与删除都以当前行为界,多行编辑时更符合直觉。
      const starts = lineStarts(value);
      const row = countLines(value.slice(0, cursor)) - 1;
      const col = cursor - starts[row]!;
      const lineEnd = row + 1 < starts.length ? starts[row + 1]! - 1 : value.length;

      if (key.ctrl && input === 'a') {
        setCursor(starts[row]!);
        return;
      }
      if (key.ctrl && input === 'e') {
        setCursor(lineEnd);
        return;
      }
      if (key.ctrl && input === 'u') {
        setValue(value.slice(0, starts[row]!) + value.slice(cursor));
        setCursor(starts[row]!);
        return;
      }
      if (key.ctrl && input === 'k') {
        setValue(value.slice(0, cursor) + value.slice(lineEnd));
        return;
      }
      if (key.ctrl && input === 'w') {
        const head = value.slice(0, cursor);
        const boundary = head.trimEnd().replace(/\S+$/, '').length;
        setValue(value.slice(0, boundary) + value.slice(cursor));
        setCursor(boundary);
        return;
      }
      // ctrl+v 粘贴剪贴板图片(cmd+v 被终端拦截为文本粘贴,到不了这里)。
      if (key.ctrl && input === 'v') {
        pasteImage();
        return;
      }

      if (key.upArrow || key.downArrow) {
        // 文件菜单打开 → 在文件菜单里移动(优先于历史/多行光标逻辑)。
        if (fileMatches.length > 0) {
          setFileMenuTouched(true);
          setFileMenuIndex(
            key.upArrow
              ? (fileCursor + fileMatches.length - 1) % fileMatches.length
              : (fileCursor + 1) % fileMatches.length,
          );
          return;
        }
        // 菜单打开 → 在菜单里移动。
        if (matches.length > 0) {
          setMenuIndex(
            key.upArrow
              ? (menuCursor + matches.length - 1) % matches.length
              : (menuCursor + 1) % matches.length,
          );
          return;
        }
        // 正在浏览历史(内容未被编辑) → 继续翻历史,即使条目是多行的。
        const browsing = historyIndex !== undefined && value === history[historyIndex];
        // 多行草稿 → 上下键在行间移动光标,避免误触历史覆盖草稿。
        if (!browsing && value.includes('\n')) {
          const target = key.upArrow ? row - 1 : row + 1;
          if (target >= 0 && target < starts.length) {
            const targetEnd = target + 1 < starts.length ? starts[target + 1]! - 1 : value.length;
            setCursor(Math.min(starts[target]! + col, targetEnd));
          }
          return;
        }
        if (key.upArrow) {
          if (history.length === 0) return;
          const next = historyIndex === undefined ? 0 : Math.min(history.length - 1, historyIndex + 1);
          setHistoryIndex(next);
          setValue(history[next]!);
          setCursor(history[next]!.length);
        } else {
          if (historyIndex === undefined) return;
          if (historyIndex === 0) {
            setHistoryIndex(undefined);
            setValue('');
            setCursor(0);
            return;
          }
          const next = historyIndex - 1;
          setHistoryIndex(next);
          setValue(history[next]!);
          setCursor(history[next]!.length);
        }
        return;
      }

      // 忽略以原始输入形式到达的控制序列。
      if (key.ctrl || key.meta || key.escape) return;
      if (input) insert(input.replace(/\r\n?/g, '\n'));

      function insert(text: string) {
        setValue(value.slice(0, cursor) + text + value.slice(cursor));
        setCursor(cursor + text.length);
      }
    },
    { isActive: !disabled },
  );

  // ── 二级选择器视图 ──
  if (selector) {
    const { options, cursor: selCursor, loading, selected } = selector;
    const multi = selector.command.multi === true;
    const windowStart = Math.max(
      0,
      Math.min(selCursor - Math.floor(SELECTOR_WINDOW / 2), options.length - SELECTOR_WINDOW),
    );
    const visible = options.slice(windowStart, windowStart + SELECTOR_WINDOW);
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
          <Text bold color={theme.accent}>
            /{selector.command.name}
          </Text>
          {loading ? (
            <Text color={theme.dim}>
              {glyphs.running} {t('selector.loading')}
            </Text>
          ) : (
            <>
              {windowStart > 0 ? (
                <Text color={theme.dim}>{t('selector.moreAbove', { n: windowStart })}</Text>
              ) : null}
              {visible.map((option, i) => {
                const index = windowStart + i;
                const active = index === selCursor;
                return (
                  <Text key={option.value} color={active ? theme.accent : undefined}>
                    {active ? `${glyphs.pointer} ` : '  '}
                    {multi ? (
                      <Text color={selected.has(option.value) ? theme.success : theme.dim}>
                        {selected.has(option.value) ? glyphs.bullet : glyphs.pending}{' '}
                      </Text>
                    ) : null}
                    {option.value}
                    {!multi && option.current ? (
                      <Text color={theme.success}>
                        {' '}
                        {glyphs.done} {t('selector.current')}
                      </Text>
                    ) : null}
                    {option.label ? <Text color={theme.dim}> — {option.label}</Text> : null}
                  </Text>
                );
              })}
              {windowStart + SELECTOR_WINDOW < options.length ? (
                <Text color={theme.dim}>
                  {t('selector.moreBelow', { n: options.length - windowStart - SELECTOR_WINDOW })}
                </Text>
              ) : null}
            </>
          )}
        </Box>
        <Box paddingLeft={2}>
          <Text color={theme.dim}>{t(multi ? 'selector.multiHint' : 'selector.hint')}</Text>
        </Box>
      </Box>
    );
  }

  // ── 输入框视图 ──
  const lines = value.split('\n');
  const cursorRow = countLines(value.slice(0, cursor)) - 1;
  const cursorCol = cursor - (value.lastIndexOf('\n', cursor - 1) + 1);
  const modeStyle = inputModeStyle(mode);
  const borderColor = disabled || busy ? theme.dim : modeStyle.color;
  const promptColor = disabled ? theme.dim : modeStyle.color;

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={borderColor} paddingX={1}>
        <Text color={promptColor}>{modeStyle.glyph} </Text>
        {value.length === 0 ? (
          <Text>
            {!disabled ? <Text inverse> </Text> : null}
            <Text color={theme.dim}>{placeholder}</Text>
          </Text>
        ) : (
          <Box flexDirection="column">
            {lines.map((line, i) => (
              <Text key={i}>
                {i === cursorRow ? (
                  <>
                    {line.slice(0, cursorCol)}
                    <Text inverse>{line[cursorCol] ?? ' '}</Text>
                    {line.slice(cursorCol + 1)}
                  </>
                ) : (
                  line || ' '
                )}
              </Text>
            ))}
          </Box>
        )}
      </Box>
      {matches.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {menuWindowStart > 0 ? (
            <Text color={theme.dim}>{t('selector.moreAbove', { n: menuWindowStart })}</Text>
          ) : null}
          {matches.slice(menuWindowStart, menuWindowStart + MENU_WINDOW).map((c, i) => {
            const index = menuWindowStart + i;
            return (
              <Text key={c.name} color={index === menuCursor ? theme.accent : undefined}>
                {index === menuCursor ? `${glyphs.pointer} ` : '  '}
                <Text color={theme.accent}>{formatCommandLabel(c)}</Text>
                {c.options ? <Text color={theme.dim}> ▸</Text> : null}
                <Text color={theme.dim}> — {c.description}</Text>
              </Text>
            );
          })}
          {menuWindowStart + MENU_WINDOW < matches.length ? (
            <Text color={theme.dim}>
              {t('selector.moreBelow', { n: matches.length - menuWindowStart - MENU_WINDOW })}
            </Text>
          ) : null}
          <Text color={theme.dim}>{t('input.menuHint')}</Text>
        </Box>
      ) : null}
      {fileLoading || fileMatches.length > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {fileLoading ? (
            <Text color={theme.dim}>
              {glyphs.running} {t('input.filesLoading')}
            </Text>
          ) : (
            <>
              {fileWindowStart > 0 ? (
                <Text color={theme.dim}>{t('selector.moreAbove', { n: fileWindowStart })}</Text>
              ) : null}
              {fileMatches.slice(fileWindowStart, fileWindowStart + MENU_WINDOW).map((file, i) => {
                const index = fileWindowStart + i;
                return (
                  <Text key={file} color={index === fileCursor ? theme.accent : undefined}>
                    {index === fileCursor ? `${glyphs.pointer} ` : '  '}
                    {file}
                  </Text>
                );
              })}
              {fileWindowStart + MENU_WINDOW < fileMatches.length ? (
                <Text color={theme.dim}>
                  {t('selector.moreBelow', {
                    n: fileMatches.length - fileWindowStart - MENU_WINDOW,
                  })}
                </Text>
              ) : null}
              <Text color={theme.dim}>{t('input.fileHint')}</Text>
            </>
          )}
        </Box>
      ) : null}
      {pastedImages.size > 0 ? (
        <Box paddingLeft={2}>
          <Text color={theme.dim}>{t('input.imagesAttached', { n: pastedImages.size })}</Text>
        </Box>
      ) : null}
      {value.includes('\n') ? (
        <Box paddingLeft={2}>
          <Text color={theme.dim}>{t('input.newlineHint')}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** 候选路径是否以输入串开头(整条路径或文件名),大小写不敏感。 */
function isPrefixMatch(query: string, candidate: string): boolean {
  if (!query) return false;
  const q = query.toLowerCase();
  const path = candidate.toLowerCase();
  return path.startsWith(q) || path.slice(path.lastIndexOf('/') + 1).startsWith(q);
}

/** 光标(退格作用点)所落在的图片占位符区间;不在任何占位符上返回 undefined。 */
function placeholderSpanAt(
  value: string,
  cursor: number,
): { start: number; end: number } | undefined {
  for (const match of value.matchAll(IMAGE_PLACEHOLDER)) {
    const start = match.index;
    const end = start + match[0].length;
    // cursor === end 即光标紧跟在 `]` 之后——最常见的"刚粘贴完就退格"。
    if (cursor > start && cursor <= end) return { start, end };
  }
  return undefined;
}

/**
 * 从光标处向左识别 @token:扫到最近的空白/行首为止,该位置必须正好是
 * `@`(即 `@` 在行首或空白之后,`foo@bar.com` 不触发)。返回 token 的
 * 起始下标与 `@` 到光标之间的查询串;查询串里再出现 `@` 视为非引用。
 */
function atTokenAt(
  value: string,
  cursor: number,
): { start: number; query: string } | undefined {
  let i = cursor - 1;
  while (i >= 0 && !/\s/.test(value[i]!)) i--;
  const start = i + 1;
  if (value[start] !== '@' || start >= cursor) return undefined;
  const query = value.slice(start + 1, cursor);
  if (query.includes('@')) return undefined;
  return { start, query };
}

/** 每一行在整个字符串中的起始下标。 */
function lineStarts(value: string): number[] {
  const starts = [0];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') n++;
  }
  return n;
}
