import { t } from '../../i18n/index.js';
import {
  reasoningEffortSchema,
  TIMELINE_MODES,
  type TimelineMode,
} from '../../config/schema.js';
import { saveReasoningEffort, saveTheme, saveTimelineMode } from '../../config/save.js';
import { applyTheme, BUILTIN_THEME_NAME, listThemes, loadTheme, themeLocations } from '../theme-loader.js';
import { supportedEfforts } from '../../model/reasoning.js';
import type { ReasoningEffort } from '../../config/schema.js';
import type { SessionHandle } from '../../app/session-handle.js';
import type { CommandHandler } from './types.js';

/** 配置类命令:think / setting / focus / theme / provider / models。 */

/**
 * /think 选择器与参数校验同源的可选档位。生效可选集由 Session 的
 * `modelCapabilities` 给出(目录优先、缺口回退家族表、剔除 wire 发不出去的
 * 档位,都在那一处);这里只兜 RPC 失败——server 抖动时仍能用家族表出个单子。
 * 'auto' 不列(用户的决定)——它是"什么都不发"的初始默认态,不作为可点档位,
 * `/think auto` 裸参数仍被接受(下面的显式出口)。
 */
export async function selectableEfforts(session: SessionHandle): Promise<ReasoningEffort[]> {
  const caps = await session
    .modelCapabilities(session.provider.id, session.provider.model)
    .catch(() => undefined);
  return (caps?.efforts ?? supportedEfforts(session.provider)).filter((l) => l !== 'auto');
}

export const think: CommandHandler = async (ctx, arg) => {
  // 档位与当前 provider/model 绑定:只接受它能完整表达的值,不支持的档位
  // 直接拒绝并列出可用项(selectableEfforts,与选择器同一来源)。
  // `/think auto` 显式输入免校验直通——它是唯一的"回到什么参数都不发"的
  // 出口,而且不必为它拉一次能力目录。
  const parsed = reasoningEffortSchema.safeParse(arg);
  const level = parsed.success ? parsed.data : undefined;
  if (level === undefined || level !== 'auto') {
    const valid = await selectableEfforts(ctx.session);
    if (level === undefined || !valid.includes(level)) {
      ctx.push({
        kind: 'notice',
        level: 'warn',
        message: t('notice.thinkUsage', { list: valid.join('|'), level: ctx.think() }),
      });
      return;
    }
  }
  // 档位必须落到真正跑模型的进程:本地会话改共享的 provider/config
  // 对象,远程会话(client-server)则经 RPC 送达——细节收进 Session 契约。
  // RPC 会 reject(server 抖动),而这里是 `void` 调用的:
  // 不接住就是未捕获 rejection,整个 TUI 被掀掉。
  try {
    await ctx.session.setReasoningEffort(level);
  } catch (err) {
    ctx.push({ kind: 'error', message: (err as Error).message });
    return;
  }
  ctx.setThink(level);
  ctx.push({ kind: 'notice', level: 'info', message: t('notice.thinkSet', { level }) });
  await saveReasoningEffort(ctx.session.provider.id, level).catch((err: Error) => {
    ctx.push({ kind: 'notice', level: 'warn', message: t('notice.thinkSaveFailed', { message: err.message }) });
  });
};

// 设置面板:语言与状态栏都收在这里(旧的 /lang、/statusbar 已并入)。
// 面板自己带按键处理,命令只负责把它打开。
//
// 刻意不进 BUSY_BLOCKED_COMMANDS:面板只改显示层,碰不到进行中的流。
// 代价是它开着时 Input 卸载,想插话引导得先 esc 关掉面板。
// (/settings 别名已在 dispatch 入口归一为 setting。)
export const setting: CommandHandler = (ctx) => {
  ctx.setSettingsOpen(true);
};

export const focus: CommandHandler = async (ctx, arg) => {
  if (!arg || !(TIMELINE_MODES as readonly string[]).includes(arg)) {
    ctx.push({
      kind: 'notice',
      level: arg ? 'warn' : 'info',
      message: t('notice.focusUsage', {
        list: TIMELINE_MODES.join(' | '),
        current: ctx.timelineMode(),
      }),
    });
    return;
  }
  const next = arg as TimelineMode;
  ctx.setTimelineMode(next);
  ctx.session.config.timeline = next;
  ctx.push({ kind: 'notice', level: 'info', message: t('notice.focusSet', { mode: next }) });
  await saveTimelineMode(next).catch((err: Error) => {
    ctx.push({
      kind: 'notice',
      level: 'warn',
      message: t('notice.focusSaveFailed', { message: err.message }),
    });
  });
};

/**
 * `/theme <name>`:运行期换配色。主题文件的查找与启动时(tui.tsx 的
 * applyConfiguredTheme)同一条路;`default` 回到内置配色。换色只改
 * palette 那一张表,已画出的行不会自己变——由 ctx.refreshTheme 整树重挂载。
 * 落盘写顶层 `theme`(default 则删掉),下次启动直接生效。
 */
export const theme: CommandHandler = async (ctx, arg) => {
  const name = arg;
  const dirs = themeLocations(ctx.session.root, ctx.session.themeDirs ?? []);
  if (!name) {
    const names = [BUILTIN_THEME_NAME, ...(await listThemes(dirs)).map((entry) => entry.name)];
    ctx.push({
      kind: 'notice',
      level: 'info',
      message: t('notice.themeUsage', {
        list: names.join(' | '),
        current: ctx.session.config.theme ?? BUILTIN_THEME_NAME,
      }),
    });
    return;
  }
  let file: string | undefined;
  if (name === BUILTIN_THEME_NAME) {
    applyTheme({});
    ctx.session.config.theme = undefined;
  } else {
    const result = await loadTheme(name, dirs);
    if (!result.ok) {
      // 选择器里光标经过时换上的预览色,在它关闭时已收回到已提交的那套
      // (Input 的 onHighlight(undefined)),这里只提示。
      ctx.push({
        kind: 'notice',
        level: 'warn',
        message:
          result.reason === 'not-found'
            ? t('notice.themeNotFound', { name })
            : t('notice.themeInvalid', { detail: result.detail ?? name }),
      });
      return;
    }
    applyTheme(result.theme.colors);
    ctx.session.config.theme = name;
    file = result.theme.file;
  }
  ctx.refreshTheme(file);
  ctx.push({ kind: 'notice', level: 'info', message: t('notice.themeSet', { name }) });
  await saveTheme(name === BUILTIN_THEME_NAME ? undefined : name, ctx.session.root).catch((err: Error) => {
    ctx.push({ kind: 'notice', level: 'warn', message: t('notice.themeSaveFailed', { message: err.message }) });
  });
};

export const provider: CommandHandler = async (ctx, arg) => {
  if (!arg) {
    // 无参数:打开厂商选择器——已配 key 的 ✓ 即切,未配的就地输入验证。
    ctx.setProviderPicker(ctx.providerActions.providerRows());
    return;
  }
  await ctx.providerActions.applyProviderSwitch(arg);
};

export const models: CommandHandler = async (ctx, arg) => {
  if (!arg) {
    // 无参数:并发拉取所有已配置厂商的模型列表,打开分组选择器。
    // 整体 RPC 失败(如 server 不在)时提示一句,选择器只剩手动输入行。
    ctx.setWork({ phase: 'listingModels', since: Date.now() });
    let groups: Awaited<ReturnType<typeof ctx.session.listProviderModels>>;
    try {
      groups = await ctx.session.listProviderModels();
    } catch {
      ctx.push({ kind: 'notice', level: 'warn', message: t('notice.modelsUnavailable') });
      groups = [];
    }
    ctx.endWork();
    ctx.setModelsPicker(groups);
    return;
  }
  // 只发 model:server 按实时 provider 解析(见 applyModelSwitch 的说明)。
  await ctx.providerActions.applyModelSwitch(undefined, arg);
};
