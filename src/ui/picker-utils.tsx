import { batch, createSignal } from 'solid-js';
import { Box, Text, type JSX, type Key } from './kit.js';
import { theme } from './theme.js';
import { t } from '../i18n/index.js';

// 窗口起点住在零依赖的 core/ui-kit(扩展画的列表也要用同一份,而那个模块
// 不能 import solid/kit);这里原样再导出,TUI 侧的 import 路径不变。
export { centeredWindowStart } from '../core/ui-kit.js';

/**
 * 一行文本输入的按键语义:退格删一个,可打印字符追加(粘贴去掉换行)。
 * 抽出来是因为它有三个用户——手动输入态、扩展提问的 input 框、`ui-kit`
 * 的 textInput,而"IME、粘贴怎么处理"这件事只允许有一处答案。
 */
export function applyTextKey(buffer: string, input: string, key: Key): string {
  if (key.backspace || key.delete) return buffer.slice(0, -1);
  if (!key.ctrl && !key.meta && input) return buffer + input.replace(/[\r\n]/g, '');
  return buffer;
}

export interface ManualEntry {
  /** 是否处于内嵌输入态。 */
  open: () => boolean;
  buffer: () => string;
  /** 进入输入态(清空缓冲)。已打开时是幂等的。 */
  openEntry: () => void;
  /**
   * 输入态的按键处理;返回 true 表示按键已被消费(输入态打开时恒为 true),
   * 调用方在自己的 useInput 顶部先问它。粘贴是去换行的多字符块。
   */
  handleKey: (input: string, key: Key) => boolean;
}

/**
 * "手动输入一个 id"的内嵌输入态:esc 退出、回车提交(空串不提交)、
 * 退格删一个字符。ModelPicker / ModelsPicker 共用同一状态机——它的
 * 行为改动(IME、粘贴)只允许发生在这一处。
 */
export function createManualEntry(onSubmit: (value: string) => void): ManualEntry {
  const [open, setOpen] = createSignal(false);
  const [buffer, setBuffer] = createSignal('');
  return {
    open,
    buffer,
    openEntry: () => {
      // 幂等:输入中再点手动行不能把已敲的缓冲清掉。
      if (open()) return;
      batch(() => {
        setOpen(true);
        setBuffer('');
      });
    },
    handleKey: (input, key) => {
      if (!open()) return false;
      if (key.escape) {
        batch(() => {
          setOpen(false);
          setBuffer('');
        });
      } else if (key.return) {
        const trimmed = buffer().trim();
        if (trimmed) onSubmit(trimmed);
      } else {
        setBuffer((b) => applyTextKey(b, input, key));
      }
      return true;
    },
  };
}

/** 手动输入态的内嵌输入框 + 操作提示,与状态机配套的外观。 */
export function ManualEntryBox(props: { buffer: string }): JSX.Element {
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text>
          {props.buffer.length === 0 ? (
            <Text color={theme.dim}>model-id</Text>
          ) : (
            `${props.buffer}▏`
          )}
        </Text>
      </Box>
      <Text color={theme.dim}>{t('modelpicker.manualHint')}</Text>
    </Box>
  );
}
