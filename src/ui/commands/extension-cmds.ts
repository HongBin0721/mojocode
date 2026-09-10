import { t } from '../../i18n/index.js';
import type { CommandContext } from './types.js';

/**
 * 两条"不是内置命令时"的回退:扩展命令与技能。
 * 两者都可能发起一轮,拦忙逻辑各自内联(见各自注释)。
 */

/**
 * 不是内置命令时的扩展回退:查扩展命令表(如 /goal),命中则整条交给
 * runCommand 执行。
 *
 * 这里**不**拦忙、也不点 setRunning:忙不忙由扩展自己按参数判(`/goal clear`
 * 正是循环跑着的时候才要用的,一刀切拦忙就没法停了);要发起一轮的处理器
 * 自己 followUp,turn-start 会把运行态带回来。
 */
export const runExtensionCommand = async (
  ctx: CommandContext,
  name: string,
  arg: string,
): Promise<boolean> => {
  const command = ctx.session.extensionCommands.find((c) => c.name === name);
  if (!command) return false;
  void ctx.session
    .runCommand(command.name, arg)
    // RPC:不接住的话传输层 rejection 会掀掉整个 TUI(与 runSkill 同一条教训)。
    .catch((err: Error) => {
      ctx.push({ kind: 'notice', level: 'warn', message: err.message });
    });
  return true;
};

/**
 * 不是内置命令时的技能回退:查技能表,命中则整轮交给 runSkill(激活、
 * 展开、跑轮次),display 用用户敲的原文。
 * 技能发起完整一轮,运行中禁止。内联检查:
 * BUSY_BLOCKED_COMMANDS 是静态表,列不进动态发现的名字。
 */
export const runSkillCommand = async (ctx: CommandContext, name: string, arg: string, raw: string): Promise<boolean> => {
  const skill = ctx.session.skills.find((s) => s.name === name);
  if (!skill) return false;
  if (ctx.busy()) {
    ctx.push({ kind: 'notice', level: 'warn', message: t('notice.busyCommand', { name }) });
    return true;
  }
  ctx.setRunning(true);
  void ctx.session
    .runSkill(skill.name, arg, { display: raw.trim() })
    // runSkill 是 RPC:不接住的话传输层 rejection 会掀掉整个 TUI。
    .catch((err: Error) => {
      ctx.push({
        kind: 'notice',
        level: 'warn',
        message: t('notice.skillRunFailed', { message: err.message }),
      });
    })
    .finally(() => ctx.setRunning(false));
  return true;
};
