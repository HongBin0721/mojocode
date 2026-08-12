import { For, Show } from 'solid-js';
import { Box, Text, type JSX } from './kit.js';
import { theme, modeColor, shortenHome } from './theme.js';
import { logoGradient, pixelLogoWidth, renderPixelLogo } from './logo.js';
import { APP_NAME } from '../config/paths.js';
import { packageVersion } from '../config/version.js';
import { t } from '../i18n/index.js';

interface Props {
  providerLabel: string;
  model: string;
  root: string;
  mode: string;
  mcpSummary?: string;
  /** 终端列宽。放不下像素字时退回纯文字标题(见 fitsLogo)。 */
  columns?: number;
}

/** 名字是常量,点阵与渐变在模块加载时算一次就够。 */
const LOGO_ROWS = renderPixelLogo(APP_NAME);
const LOGO_WIDTH = pixelLogoWidth(APP_NAME);
const LOGO_COLORS = logoGradient([...APP_NAME].length);

/** 圆角边框 2 列 + paddingX 各 1 列。 */
const FRAME_COLS = 4;

const VERSION = `v${packageVersion()}`;

export function Header(props: Props): JSX.Element {
  // 宽度不够就不画:像素字一旦折行,半块字符会碎成一片噪点,比没有更难看。
  // columns 缺省时按能画处理(叶子组件单测/非 Timeline 调用点不传宽度)。
  const fitsLogo = (): boolean => (props.columns ?? Infinity) - FRAME_COLS >= LOGO_WIDTH;

  // 版本号先量后画:单行信息行一旦溢出,flex 会压缩子项并吞掉分隔符两侧的空格
  // (Footer.fitParts 防的同一问题),所以放不下就整段不显示,标题行保持原样。
  const showVersion = (): boolean => {
    const inner = (props.columns ?? Infinity) - FRAME_COLS;
    const modeCols = props.mode !== 'ask' ? 3 + props.mode.length : 0;
    const base =
      (fitsLogo() ? 0 : APP_NAME.length + 3) +
      props.providerLabel.length +
      3 +
      props.model.length +
      modeCols;
    // logo 模式下版本号自带 " · " 分隔;纯文字模式复用名字后原有的分隔,只多出一个空格。
    const versionCols = VERSION.length + (fitsLogo() ? 3 : 1);
    return inner >= base + versionCols;
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Show when={fitsLogo()}>
        <Box flexDirection="column" marginBottom={1}>
          <For each={LOGO_ROWS}>
            {(row) => (
              <Text>
                {/* 逐字一段,段与段之间只差颜色——整行一个 Text 就没法做渐变。 */}
                <For each={row}>
                  {(seg, i) => <Text color={LOGO_COLORS[i()] ?? theme.accent}>{seg}</Text>}
                </For>
              </Text>
            )}
          </For>
        </Box>
      </Show>
      <Box>
        {/* 画得出 logo 时行首不再重复写一遍名字,省一段横向空间给模型名。 */}
        <Show when={!fitsLogo()}>
          <Text bold color={theme.accent}>
            {APP_NAME}
          </Text>
        </Show>
        {/* 版本号补在名字的位置:画 logo 时名字不重复出现,版本号就是这一行的开头。 */}
        <Show when={showVersion()}>
          <Text color={theme.dim}>{fitsLogo() ? '' : ' '}{VERSION}</Text>
        </Show>
        <Show when={!fitsLogo() || showVersion()}>
          <Text color={theme.dim}> · </Text>
        </Show>
        <Text>{props.providerLabel}</Text>
        <Text color={theme.dim}> · </Text>
        <Text color={theme.accent}>{props.model}</Text>
        <Show when={props.mode !== 'ask'}>
          <Text color={theme.dim}> · </Text>
          <Text color={modeColor(props.mode)}>{props.mode}</Text>
        </Show>
      </Box>
      <Box>
        <Text color={theme.dim}>{shortenHome(props.root)}</Text>
        <Show when={props.mcpSummary}>
          <Text color={theme.dim}> · mcp: {props.mcpSummary}</Text>
        </Show>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>{t('header.hints')}</Text>
      </Box>
    </Box>
  );
}
