import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme, glyphs } from './theme.js';
import { t } from '../i18n/index.js';

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

interface Props {
  onSubmit: (value: string) => void;
  disabled: boolean;
  placeholder: string;
  /** 自动补全菜单中展示的斜杠命令。 */
  commands: SlashCommand[];
}

interface SelectorState {
  command: SlashCommand;
  options: CommandOption[];
  cursor: number;
  loading: boolean;
  /** 多选模式下当前选中的值集合。 */
  selected: Set<string>;
}

/** 二级选择器一屏最多显示的选项数,超出部分滚动。 */
const SELECTOR_WINDOW = 8;
/** 命令菜单最多显示的候选数。 */
const MENU_LIMIT = 8;

/**
 * 带历史记录、多行编辑和斜杠命令菜单的输入框。
 *
 * 手写而不用 ink-text-input,是因为多行输入、历史回溯、命令菜单和
 * 二级选择器需要共用同一个按键处理器——把这些叠加在受控的第三方
 * 输入组件上反而更乱。
 *
 * 换行方式:shift+enter(kitty 键盘协议,iTerm2 3.5+/kitty/WezTerm/
 * Ghostty 等终端可用)、option+enter、ctrl+j,以及行尾 `\` + 回车
 * (任何终端都可用的兜底)。传统终端把 shift+enter 和 enter 发成同一个
 * 字节,无法区分,所以需要这些替代按键。
 */
export function Input({ onSubmit, disabled, placeholder, commands }: Props): React.ReactElement {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>(undefined);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [selector, setSelector] = useState<SelectorState | undefined>(undefined);
  // 递增代号,防止上一次异步加载的选项覆盖已关闭/重开的选择器。
  const selectorGen = useRef(0);

  // 输入变化时重置菜单选中项,并让被 esc 收起的菜单重新出现。
  useEffect(() => {
    setMenuIndex(0);
    setMenuDismissed(false);
  }, [value]);

  const showMenu =
    !selector &&
    !menuDismissed &&
    value.startsWith('/') &&
    !value.includes(' ') &&
    !value.includes('\n');
  const matches = showMenu
    ? commands.filter((c) => c.name.startsWith(value.slice(1).toLowerCase())).slice(0, MENU_LIMIT)
    : [];
  const menuCursor = matches.length > 0 ? Math.min(menuIndex, matches.length - 1) : 0;

  /**
   * 菜单上回车/tab 作用的命令。精确匹配优先于光标位置:`model` 排在 `mode`
   * 之前,输完整的 `/mode` 时光标默认停在 `model` 上,直接取光标项会执行错
   * 命令。用户主动移动过光标(menuIndex 非 0)时以光标为准。
   */
  function menuTarget(): SlashCommand | undefined {
    if (matches.length === 0) return undefined;
    if (menuIndex === 0) {
      const exact = matches.find((c) => c.name === value.slice(1).toLowerCase());
      if (exact) return exact;
    }
    return matches[menuCursor];
  }

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setHistory((prev) => [trimmed, ...prev.filter((h) => h !== trimmed)].slice(0, 100));
    setHistoryIndex(undefined);
    setValue('');
    setCursor(0);
    onSubmit(trimmed);
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

      if (key.tab && matches.length > 0) {
        const completed = `/${menuTarget()!.name} `;
        setValue(completed);
        setCursor(completed.length);
        return;
      }

      if (key.escape && matches.length > 0) {
        setMenuDismissed(true);
        return;
      }

      if (key.backspace || key.delete) {
        if (cursor > 0) {
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

      if (key.upArrow || key.downArrow) {
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

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={disabled ? theme.dim : theme.accent} paddingX={1}>
        <Text color={disabled ? theme.dim : theme.accent}>{glyphs.prompt} </Text>
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
          {matches.map((c, index) => (
            <Text key={c.name} color={index === menuCursor ? theme.accent : undefined}>
              {index === menuCursor ? `${glyphs.pointer} ` : '  '}
              <Text color={theme.accent}>/{c.name}</Text>
              {c.options ? <Text color={theme.dim}> ▸</Text> : null}
              <Text color={theme.dim}> — {c.description}</Text>
            </Text>
          ))}
          <Text color={theme.dim}>{t('input.menuHint')}</Text>
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
