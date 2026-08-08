import { createSignal, For, Show } from 'solid-js';
import { Box, Text, useInput, type JSX } from './kit.js';
import { theme, glyphs, modeColor } from './theme.js';
import { t } from '../i18n/index.js';

/** 一档权限。plan 与四个预设并列——底栏那一段显示的就是这五种取值。 */
export interface ModeOption {
  /** 预设 id 或 'plan';回传给调用方的就是它。 */
  id: string;
  /** 已本地化的说明。 */
  label: string;
  current: boolean;
}

interface Props {
  options: ModeOption[];
  onPick: (id: string) => void;
  onCancel: () => void;
}

/**
 * 点击底栏权限档位弹出的选项框。
 *
 * 与 RewindPicker / SettingsPanel 同一个前提:它渲染期间 Input 与 Footer
 * 已卸载(App 的渲染分支互斥),自带的 useInput 不会与输入框抢按键。
 *
 * 刻意不做滚动窗口:档位一共五种,永远一屏装得下,那套 windowStart 的机器
 * 在这里只是噪音。
 *
 * 语义上它等价于「一次 shift+tab,但由你指定落在哪一档」——只改本会话,不
 * 落盘。要写进工作区配置仍然只有 /approvals 一条路(底部注脚说的就是这件事):
 * 点一下底栏不该改写项目配置文件。
 */
export function ModePicker(props: Props): JSX.Element {
  const [cursor, setCursor] = createSignal(Math.max(0, props.options.findIndex((o) => o.current)));

  useInput((_input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    const total = props.options.length;
    if (total === 0) return;
    if (key.upArrow) {
      setCursor((c) => (c + total - 1) % total);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % total);
      return;
    }
    if (key.return) {
      const option = props.options[cursor()];
      if (option) props.onPick(option.id);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text bold color={theme.accent}>
          {t('modepicker.title')}
        </Text>
        <For each={props.options}>
          {(option, i) => {
            const active = () => i() === cursor();
            return (
              // 点击即选定该档(等价于把光标移过去再回车)。
              <Text
                color={active() ? theme.accent : undefined}
                wrap="truncate-end"
                onClick={() => props.onPick(option.id)}
              >
                {active() ? `${glyphs.pointer} ` : '  '}
                {/* 档位名用与底栏/输入框同一套配色:full-access 一眼是警示色。 */}
                <Text color={modeColor(option.id)} bold={active()}>
                  {option.id}
                </Text>
                <Show when={option.current}>
                  <Text color={theme.success}>
                    {' '}
                    {glyphs.done} {t('selector.current')}
                  </Text>
                </Show>
                <Text color={theme.dim}> — {option.label}</Text>
              </Text>
            );
          }}
        </For>
        <Text color={theme.dim}>{t('modepicker.note')}</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color={theme.dim}>{t('selector.hint')}</Text>
      </Box>
    </Box>
  );
}
