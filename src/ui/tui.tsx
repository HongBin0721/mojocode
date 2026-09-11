import process from 'node:process';
import { render } from './kit.js';
import { App } from './App.js';
import { AuthWizard } from './AuthWizard.js';
import { SessionPicker } from './SessionPicker.js';
import { formatTranscript } from './transcript.js';
import type { SessionHandle } from '../app/session-handle.js';
import type { TimelineItem } from './types.js';
import type { SessionMeta } from '../session/store.js';
import { applyTheme, loadTheme, themeLocations } from './theme-loader.js';
import { t } from '../i18n/index.js';

/**
 * TUI 的动态 import 边界。cli.tsx 只能 `await import('./ui/tui.js')` 进来,
 * 不得静态引用本模块或其下游(kit → @opentui/core 在模块加载期就要拿原生
 * FFI):`-p` headless 与全部子命令必须在 Node 22 上照常工作,detect 与
 * import 的顺序见 src/app/runtime.ts。
 */

/** 主 TUI:渲染 App,退出后把时间线 dump 回主屏 scrollback。 */
export async function runTui(session: SessionHandle): Promise<void> {
  const itemsRef: { current: TimelineItem[] } = { current: [] };
  // 主题在 render 之前就地换色(theme-loader.ts 说明了为什么只换这一次)。
  // 找不到 / 解析失败不拦启动;提示要等 App 挂上 bus 之后再发,不然没人听见。
  const themeNotice = await applyConfiguredTheme(session);
  const instance = await render(() => <App session={session} itemsRef={itemsRef} />);
  if (themeNotice) session.bus.emit({ type: 'notice', level: 'warn', message: themeNotice });
  await instance.waitUntilExit();
  // 此刻 alternate screen 已还原,stdout 回到主屏。
  if (itemsRef.current.length > 0) {
    process.stdout.write(formatTranscript(itemsRef.current, process.stdout.columns ?? 80));
  }
}

/** 配置 `theme` 指名的主题:项目 > 全局 > 包与扩展贡献的目录。返回要提示的问题(没有为 undefined)。 */
async function applyConfiguredTheme(session: SessionHandle): Promise<string | undefined> {
  const name = session.config.theme;
  if (!name) return undefined;
  const result = await loadTheme(name, themeLocations(session.root, session.themeDirs ?? []));
  if (result.ok) {
    applyTheme(result.theme.colors);
    return undefined;
  }
  return result.reason === 'not-found'
    ? t('notice.themeMissing', { name })
    : t('notice.themeInvalid', { detail: result.detail ?? name });
}

export async function runAuthWizard(): Promise<void> {
  const instance = await render(() => <AuthWizard />, { exitOnCtrlC: true });
  await instance.waitUntilExit();
}

/** 启动期会话选择器;esc/ctrl+c 返回 undefined(开新会话)。 */
export async function runSessionPicker(sessions: SessionMeta[]): Promise<string | undefined> {
  let picked: string | undefined;
  const instance = await render(
    () => (
      <SessionPicker
        sessions={sessions}
        onSelect={(id) => {
          picked = id;
        }}
      />
    ),
    { exitOnCtrlC: true },
  );
  await instance.waitUntilExit();
  return picked;
}
