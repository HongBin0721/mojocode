import { t } from '../../i18n/index.js';
import {
  APPROVAL_PRESETS,
  isDangerousPermissions,
  presetById,
  reasoningEffortSchema,
  TIMELINE_MODES,
  type TimelineMode,
} from '../../config/schema.js';
import { saveReasoningEffort, saveTimelineMode } from '../../config/save.js';
import { supportedEfforts } from '../../model/reasoning.js';
import type { CommandHandler } from './types.js';

/** 配置类命令:approvals / think / setting / focus / provider / models。 */

export const approvals: CommandHandler = async (ctx, arg) => {
  const preset = APPROVAL_PRESETS.find((p) => p.id === arg);
  if (!preset) {
    ctx.push({
      kind: 'notice',
      level: 'warn',
      message: t('notice.approvalsUsage', {
        list: APPROVAL_PRESETS.map((p) => p.id).join('|'),
        mode: ctx.modeLabel(),
      }),
    });
    return;
  }
  const next = presetById(preset.id);
  ctx.session.setPermissions(next);
  ctx.setPerms(next);
  ctx.setPlanActive(false);
  ctx.push({ kind: 'notice', level: 'info', message: t('notice.modeSet', { mode: preset.id }) });
  // full-access 绕过硬拒名单,而且和别的档位一样会留到下次启动——
  // 时间线上必须留一条,事后翻记录能认出这一段跑在无沙箱下。
  if (isDangerousPermissions(next)) {
    ctx.push({
      kind: 'notice',
      level: 'warn',
      message: t('notice.modeDanger', { mode: preset.id }),
    });
  }
  // 落盘范围是本工作区的 .mojocode/config.json,不碰全局配置。
  const saved = await ctx.persistPermissions(next);
  if (saved) {
    ctx.push({ kind: 'notice', level: 'info', message: t('notice.modeSavedTo', { path: saved }) });
  }
};

export const think: CommandHandler = async (ctx, arg) => {
  // 档位与当前 provider/model 绑定:只接受它能完整表达的值,
  // 不支持的档位直接拒绝并列出可用项。
  const valid = supportedEfforts(ctx.session.provider);
  const parsed = reasoningEffortSchema.safeParse(arg);
  if (!parsed.success || !valid.includes(parsed.data)) {
    ctx.push({
      kind: 'notice',
      level: 'warn',
      message: t('notice.thinkUsage', { list: valid.join('|'), level: ctx.think() }),
    });
    return;
  }
  const level = parsed.data;
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
