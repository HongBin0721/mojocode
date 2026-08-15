import { batch, createSignal } from 'solid-js';
import { Box, Text, type JSX, type Key } from './kit.js';
import { theme } from './theme.js';
import { t } from '../i18n/index.js';

/**
 * 围绕光标居中的窗口起点。所有窗口化列表(选择器、菜单)共用这一份,
 * 滚动手感才是同一个:光标尽量居中,列表两端各自贴边。
 */
export function centeredWindowStart(cursor: number, rowCount: number, window: number): number {
  return Math.max(0, Math.min(cursor - Math.floor(window / 2), rowCount - window));
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
      } else if (key.backspace || key.delete) {
        setBuffer((b) => b.slice(0, -1));
      } else if (!key.ctrl && !key.meta && input) {
        setBuffer((b) => b + input.replace(/[\r\n]/g, ''));
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
