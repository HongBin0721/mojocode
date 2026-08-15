import { t } from '../../i18n/index.js';
import { canEverWrite } from '../../config/schema.js';
import { formatDuration, formatTokens } from '../theme.js';
import { GOAL_CLEAR_WORDS } from './registry.js';
import type { CommandContext, CommandHandler } from './types.js';

/** plan / goal:两支都会发起一轮的命令,拦忙逻辑跟着内联(见各自注释)。 */

// 计划模式:裸 /plan 只切模式,`/plan <任务>` 顺带以任务原文发起一轮。
// 任务原文直接进历史(不像 /init 那样套 display):用户写的就是他的
// 意图本身,实时时间线与 /resume 回放因此天然一致,回退重发也能重跑。
export const plan: CommandHandler = async (ctx, arg) => {
  const { session, push } = ctx;
  // 带参数会发起一轮,运行中禁止。不走 BUSY_BLOCKED_COMMANDS——那张表
  // 按命令名判断,表达不了"只有带参数时才拦"。
  if (arg && ctx.busy()) {
    push({ kind: 'notice', level: 'warn', message: t('notice.busyCommand', { name: 'plan' }) });
    return;
  }
  if (!ctx.planActive()) {
    // read-only+never 进来的话批准后会提升到 ask,提前说明,免得用户
    // 以为设置被吞了。其余组合忠实还原,不必多话。
    if (!canEverWrite(ctx.perms(), false)) {
      push({ kind: 'notice', level: 'info', message: t('notice.planReturnFromReadonly') });
    }
    session.setPlan(true);
    ctx.setPlanActive(true);
    push({ kind: 'notice', level: 'info', message: t('notice.planEntered') });
  }
  if (!arg) return;
  ctx.setRunning(true);
  void session.agent
    .run(arg)
    // run() 自己消化模型错误,但未捕获的 rejection 在 Node ≥20 会掀掉
    // 整个 TUI——与 /init 同一条教训。
    .catch((err: Error) => {
      push({ kind: 'notice', level: 'warn', message: err.message });
    })
    .finally(() => ctx.setRunning(false));
};

// 目标模式:给一个完成条件,每轮收尾后由评估器判断达成没有,没达成
// 就以评估理由为指令自动续跑。裸 /goal 报状态、`/goal clear` 取消,
// 这两支任何时候都可用——clear 正是停下循环的手段,拦忙就没法停了。
export const goal: CommandHandler = async (ctx, arg) => {
  const { session, push } = ctx;
  const status = session.goal.snapshot();
  if (!arg) {
    push({
      kind: 'notice',
      level: 'info',
      message: !status
        ? t('notice.goalNone')
        : status.restored
          ? t('notice.goalStatusIdle', { condition: status.condition })
          : t('notice.goalStatus', {
              condition: status.condition,
              turns: status.turns,
              max: status.maxTurns,
              elapsed: formatDuration(status.elapsedMs),
              tokens: formatTokens(status.tokens),
              reason: status.lastReason || '—',
            }),
    });
    return;
  }
  if (GOAL_CLEAR_WORDS.has(arg.toLowerCase())) {
    // 提示统一由 goal-stop 事件给出,这里不再推一条。
    if (status) session.goal.clear('cleared');
    else push({ kind: 'notice', level: 'info', message: t('notice.goalNone') });
    return;
  }
  // 以下这支会发起一轮,所以要拦忙——和 `/plan <任务>` 同一个理由,
  // 同样不进 BUSY_BLOCKED_COMMANDS(那张表按命令名判断,表达不了
  // "只有这种参数形式才拦")。
  if (ctx.busy()) {
    push({ kind: 'notice', level: 'warn', message: t('notice.busyCommand', { name: 'goal' }) });
    return;
  }
  if (ctx.planActive()) {
    push({ kind: 'notice', level: 'warn', message: t('notice.goalPlanMode') });
    return;
  }
  session.goal.set(arg);
  ctx.setRunning(true);
  void session.goal
    .run(arg)
    // goal.run 和 agent.run 一样不会 reject,但未捕获的 rejection 在
    // Node ≥20 会掀掉整个 TUI——与 /init、/plan 同一条教训,照旧兜住。
    .catch((err: Error) => {
      push({ kind: 'notice', level: 'warn', message: err.message });
    })
    .finally(() => ctx.setRunning(false));
};

/**
 * 不是内置命令时的技能回退:查技能表,命中则整轮交给 runSkill(激活、
 * 展开、跑轮次都在会话进程侧),display 用用户敲的原文。
 * 技能发起完整一轮,运行中禁止。与 `/plan <任务>` 同理走内联检查:
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
