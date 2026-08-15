import { t } from '../../i18n/index.js';
import type { CommandContext, CommandHandler } from './types.js';
import { BUSY_BLOCKED_COMMANDS, canonicalCommandName } from './registry.js';
import {
  compact,
  cost,
  doctor,
  exit,
  fork,
  help,
  init,
  mcp,
  newSession,
  resume,
  skills,
} from './session-cmds.js';
import { review, simplify } from './review-cmds.js';
import { goal, plan, runSkillCommand } from './goal-plan-cmds.js';
import { approvals, focus, models, provider, setting, think } from './config-cmds.js';

/**
 * 命令分发入口(原 App.tsx 的 runCommand 巨型 switch):
 * 别名归一 → BUSY_BLOCKED 拦截 → 查表执行 → 技能回退 → unknown 提示。
 * handler 本体分住在 session-cmds / review-cmds / goal-plan-cmds / config-cmds。
 */

/** 主名 → 处理器。new/clear 共用一个实现(见 session-cmds 的注释)。 */
const HANDLERS: Record<string, CommandHandler> = {
  help,
  exit,
  new: newSession,
  clear: newSession,
  init,
  review,
  simplify,
  plan,
  goal,
  compact,
  approvals,
  think,
  setting,
  focus,
  provider,
  models,
  mcp,
  skills,
  doctor,
  cost,
  resume,
  fork,
};

export async function dispatch(ctx: CommandContext, raw: string): Promise<void> {
  const [typed, ...rest] = raw.slice(1).trim().split(/\s+/);
  // 别名先归一为主名(未知的命令保持原样,走技能回退/unknown 提示)。
  const name = typed ? canonicalCommandName(typed) : undefined;
  const arg = rest.join(' ');

  // 这些命令会改写正在被进行中的流读写的历史/模型,运行中禁止。
  // 压缩没有 controller,isRunning 期间为 false——不把它算进来的话,
  // /compact 等待摘要返回时还能执行 /clear,压缩随后会把已丢弃的对话
  // 写回内存,并存进那个全新的会话文件。
  // goal.busy 必须并进来:目标循环两轮之间的评估窗口里 agent 是空闲的,
  // 但历史随时会被下一轮接着写——不算作忙的话,`/clear`、`/models`、
  // `/resume` 会从这个缝里溜进去把历史或模型换掉。
  if (name && BUSY_BLOCKED_COMMANDS.has(name) && ctx.busy()) {
    ctx.push({ kind: 'notice', level: 'warn', message: t('notice.busyCommand', { name }) });
    return;
  }

  const handler = name ? HANDLERS[name] : undefined;
  if (handler) {
    await handler(ctx, arg);
    return;
  }

  // 不是内置命令:查技能表。命中则整轮交给 runSkill(见 goal-plan-cmds)。
  if (name && (await runSkillCommand(ctx, name, arg, raw))) return;
  ctx.push({ kind: 'notice', level: 'warn', message: t('notice.unknownCommand', { name: name ?? '' }) });
}
